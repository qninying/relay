// STORY-102 (REQ-103, REQ-104, REQ-105): the one path every state-changing
// console action goes through. In order:
//
// 1. Integrity: the request must come from this site (Origin, or Referer as
//    a fallback) and carry the session's CSRF token. Otherwise 403, audited
//    as "rejected", and nothing else happens.
// 2. Idempotency: the form's one-time key is claimed with SET NX. A second
//    request with the same key (double-click, retry, another tab) gets the
//    first request's stored result back and changes nothing; if the first is
//    still running it gets 409. The claim is atomic, so two simultaneous
//    requests can't both win.
// 3. Audit first: the "performed" entry is written BEFORE the action runs.
//    If it can't be written, the action is not run, the claim is released
//    (so the operator can retry), and they're told it failed.
// 4. The action runs. On success its result is stored under the key for 24
//    hours. On failure a "failed" entry is audited and the claim released.

import type http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Redis } from "ioredis";
import { logJson } from "../logger.js";
import type { AuditLog } from "./audit.js";
import type { Session } from "./auth/sessions.js";

export interface ActionResult {
  status: number;
  // Either a redirect target, or a short plain-text message the console
  // shows inside its page layout.
  location?: string;
  message?: string;
}

export interface ActionRequest {
  req: http.IncomingMessage;
  session: Session;
  form: URLSearchParams;
  action: string;
  target: string;
}

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const PENDING = "__pending__";

export function sameToken(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// The origin the browser should be on: Host header plus the scheme. Behind
// Fly's proxy the app sees plain http, so X-Forwarded-Proto is used only
// when the proxy is trusted.
export function expectedOrigin(req: http.IncomingMessage, trustProxy: boolean): string | null {
  const host = req.headers.host;
  if (!host) return null;
  const forwarded = req.headers["x-forwarded-proto"];
  const proto = trustProxy && typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "http";
  return `${proto}://${host}`;
}

export type IntegrityFailure = "bad_origin" | "bad_csrf";

export function checkIntegrity(req: http.IncomingMessage, session: Session, form: URLSearchParams, trustProxy: boolean): IntegrityFailure | null {
  const expected = expectedOrigin(req, trustProxy);
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;
  let source = origin;
  if (!source && typeof req.headers.referer === "string") {
    try {
      source = new URL(req.headers.referer).origin;
    } catch {
      source = null;
    }
  }
  if (!expected || !source || source !== expected) return "bad_origin";
  const token = form.get("csrf") ?? "";
  if (!token || !sameToken(token, session.csrfToken)) return "bad_csrf";
  return null;
}

export class ActionRunner {
  constructor(
    private readonly redis: Redis,
    private readonly audit: AuditLog,
    private readonly trustProxy: boolean,
    private readonly prefix = "relay:console:idem:"
  ) {}

  async perform(request: ActionRequest, run: () => Promise<ActionResult>): Promise<ActionResult> {
    const { req, session, form, action, target } = request;
    const correlationId = randomUUID();
    const base = { operator: session.username, action, target, correlationId };

    const integrity = checkIntegrity(req, session, form, this.trustProxy);
    if (integrity) {
      await this.audit.record({ ...base, outcome: "rejected", detail: integrity }).catch((error) => this.logAuditFailure(base, error));
      logJson("warn", { event: "console_action_rejected", correlationId, outcome: "failure", context: { ...base, reason: integrity } });
      return { status: 403, message: ("That request couldn't be verified. Reload the page and try again.") };
    }

    const key = form.get("idem") ?? "";
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) return { status: 400, message: ("That form is out of date. Reload the page and try again.") };
    const idemKey = `${this.prefix}${session.username}:${key}`;

    const claimed = await this.redis.set(idemKey, PENDING, "EX", IDEMPOTENCY_TTL_SECONDS, "NX");
    if (claimed !== "OK") {
      const stored = await this.redis.get(idemKey);
      await this.audit.record({ ...base, outcome: "duplicate" }).catch((error) => this.logAuditFailure(base, error));
      if (!stored || stored === PENDING) return { status: 409, message: ("That action is already being processed. Give it a moment, then reload.") };
      return JSON.parse(stored) as ActionResult;
    }

    try {
      await this.audit.record({ ...base, outcome: "performed" });
    } catch (error) {
      await this.redis.del(idemKey).catch(() => undefined);
      this.logAuditFailure(base, error);
      return { status: 503, message: ("That action wasn't done: it couldn't be recorded in the audit log. Please try again shortly.") };
    }

    let result: ActionResult;
    try {
      result = await run();
    } catch (error) {
      await this.redis.del(idemKey).catch(() => undefined);
      const errorClass = error instanceof Error ? error.constructor.name : "UnknownError";
      await this.audit.record({ ...base, outcome: "failed", detail: errorClass }).catch((e) => this.logAuditFailure(base, e));
      logJson("error", { event: "console_action_failed", correlationId, outcome: "failure", errorClass, context: base });
      return { status: 500, message: ("Something went wrong and the action didn't complete. You can try again.") };
    }

    await this.redis.set(idemKey, JSON.stringify(result), "EX", IDEMPOTENCY_TTL_SECONDS);
    logJson("info", { event: "console_action_performed", correlationId, outcome: "success", context: base });
    return result;
  }

  private logAuditFailure(base: Record<string, string>, error: unknown): void {
    logJson("error", {
      event: "console_audit_write_failed",
      correlationId: base.correlationId ?? "unknown",
      outcome: "failure",
      errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
      context: { operator: base.operator, action: base.action, target: base.target },
    });
  }
}

// A fresh one-time key for each rendered form.
export function newIdempotencyKey(): string {
  return randomUUID().replace(/-/g, "");
}
