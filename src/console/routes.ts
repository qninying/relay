// STORY-101 (REQ-101, REQ-102): the console's HTTP entry point. Mounted by
// statusServer.ts for every /console path; everything else on the server
// (the public /status, /health, ...) is untouched and needs no login.
//
//   GET  /console/login   sign-in form
//   POST /console/login   password + authenticator code -> session cookie
//   POST /console/logout  ends the session (same-origin + CSRF checked)
//   GET  /console         protected home
//   GET  /console/audit   audit log (engineers: everyone; analysts: their own)
//   POST <registered>     actions from later stories, all through
//                         ActionRunner.perform (STORY-102)
//   anything else under /console requires a valid session: pages redirect
//   to the sign-in form, /console/api/* answers 401 JSON.
//
// Failure paths (STORY-101):
// - Wrong password, wrong/expired/replayed code, unknown or disabled user:
//   one generic message, and an unknown user costs the same scrypt work as a
//   wrong password, so neither the message nor the timing says which part
//   was wrong or whether the account exists.
// - 5 failures for an account or an IP within 15 minutes: refused, even with
//   correct credentials, until the window passes (loginLimiter.ts).
// - Redis unreachable: sign-in answers 503 and protected pages answer 503;
//   nothing falls back to an unchecked session.

import type http from "node:http";
import { randomUUID } from "node:crypto";
import { logJson } from "../logger.js";
import { matchTotp } from "./auth/totp.js";
import { DUMMY_HASH, verifyPassword } from "./auth/password.js";
import type { OperatorStore } from "./auth/operators.js";
import type { Session, SessionStore } from "./auth/sessions.js";
import { SESSION_IDLE_SECONDS } from "./auth/sessions.js";
import type { LoginLimiter } from "./auth/loginLimiter.js";
import type { Role } from "./auth/operators.js";
import type { AuditLog } from "./audit.js";
import { checkIntegrity, type ActionResult, type ActionRunner } from "./actions.js";
import { esc, page } from "./layout.js";

export const SESSION_COOKIE = "relay_session";
const MAX_BODY_BYTES = 8 * 1024;
// Internal log reasons only; the user always sees GENERIC_FAILURE.
const FAIL = { unknownUser: "unknown_user", disabled: "disabled", wrongPw: "bad_password", badCode: "bad_or_reused_code" } as const;
const GENERIC_FAILURE = "That username, password or code isn't right. Check them and try again.";

// A state-changing console action, registered by a later story (batch
// submit, review decision, ...). Always run through ActionRunner.perform.
export interface PostRoute {
  action: string;
  roles: Role[];
  target: (form: URLSearchParams) => string;
  run: (session: Session, form: URLSearchParams) => Promise<ActionResult>;
}

export interface ConsoleDeps {
  audit: AuditLog;
  actions: ActionRunner;
  postRoutes?: Record<string, PostRoute>;
  operators: OperatorStore;
  sessions: SessionStore;
  limiter: LoginLimiter;
  // true in production (HTTPS on Fly); false for http://localhost.
  cookieSecure: boolean;
  // true only behind Fly's proxy, which sets Fly-Client-IP. Never trusted
  // otherwise, or anyone could pick their own IP for the rate limiter.
  trustProxy: boolean;
  now?: () => number;
}

export type ConsoleHandler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<void>;

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

function html(res: http.ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...HEADERS, ...extra });
  res.end(body);
}

function redirect(res: http.ServerResponse, location: string, extra: Record<string, string> = {}): void {
  res.writeHead(303, { Location: location, ...HEADERS, ...extra });
  res.end();
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", ...HEADERS });
  res.end(JSON.stringify(body));
}

export function readCookie(req: http.IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || null;
  }
  return null;
}

function sessionCookie(id: string, secure: boolean, maxAgeSeconds: number): string {
  return [`${SESSION_COOKIE}=${id}`, "Path=/console", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSeconds}`, ...(secure ? ["Secure"] : [])].join("; ");
}

function clientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  const forwarded = req.headers["fly-client-ip"];
  if (trustProxy && typeof forwarded === "string" && forwarded) return forwarded;
  return req.socket.remoteAddress ?? "unknown";
}

async function readForm(req: http.IncomingMessage): Promise<URLSearchParams | null> {
  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded")) return null;
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function loginPage(message: string | null, username = ""): string {
  return page({
    title: "Sign in | Relay Console",
    body: `<div class="card narrow">
  <h1>Sign in</h1>
  ${message ? `<p class="error" role="alert">${esc(message)}</p>` : ""}
  <form method="post" action="/console/login" autocomplete="on">
    <label for="username">Username</label>
    <input id="username" name="username" autocomplete="username" required maxlength="32" value="${esc(username)}" autofocus>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required maxlength="200">
    <label for="code">Authenticator code</label>
    <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" required maxlength="7" placeholder="6 digits">
    <button class="full" type="submit">Sign in</button>
  </form>
</div>`,
  });
}

function homePage(session: Session): string {
  return page({
    title: "Relay Console",
    session,
    body: `<div class="card">
  <h1>Welcome, ${esc(session.username)}</h1>
  <p>You're signed in to the Relay console as ${session.role === "engineer" ? "an engineer" : "an analyst"}.</p>
  <p><a href="/console/audit">Audit log</a>: every sign-in and action, who did it and when.</p>
  <p class="muted">Batches, review and failed jobs arrive in the next releases. Public status stays at <a href="/status">/status</a>.</p>
</div>`,
  });
}

function auditPage(session: Session, entries: Awaited<ReturnType<AuditLog["recent"]>>): string {
  const rows = entries
    .map(
      (e) => `<tr><td>${esc(e.at.replace("T", " ").slice(0, 19))}</td><td>${esc(e.operator)}</td><td>${esc(e.action)}</td><td>${esc(e.target)}</td><td>${esc(e.outcome)}${e.detail ? ` <span class="muted">(${esc(e.detail)})</span>` : ""}</td></tr>`
    )
    .join("");
  return page({
    title: "Audit log | Relay Console",
    session,
    body: `<div class="card">
  <h1>Audit log</h1>
  <p class="muted">${session.role === "engineer" ? "Every operator's" : "Your"} most recent ${entries.length} event${entries.length === 1 ? "" : "s"}, newest first. Times are UTC. Kept for 90 days.</p>
  <div style="overflow-x:auto"><table>
    <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Outcome</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="5">Nothing recorded yet.</td></tr>`}</tbody>
  </table></div>
</div>`,
  });
}

export function createConsoleHandler(deps: ConsoleDeps): ConsoleHandler {
  const now = deps.now ?? Date.now;

  // For events that must not be blocked by an audit outage (a refused
  // sign-in is refused either way; sign-out always signs out). The audit
  // failure itself is logged, never silent.
  async function auditQuietly(entry: Parameters<AuditLog["record"]>[0]): Promise<void> {
    try {
      await deps.audit.record(entry);
    } catch (error) {
      logJson("error", {
        event: "console_audit_write_failed",
        correlationId: entry.correlationId,
        outcome: "failure",
        errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
        context: { operator: entry.operator, action: entry.action },
      });
    }
  }

  function renderResult(res: http.ServerResponse, session: Session, result: ActionResult): void {
    if (result.location) return redirect(res, result.location);
    return html(res, result.status, page({ title: "Relay Console", session, body: `<div class="card"><p role="alert">${esc(result.message ?? "")}</p><p><a href="/console">Back to the console</a></p></div>` }));
  }

  async function login(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const correlationId = randomUUID();
    const form = await readForm(req);
    if (!form) return html(res, 400, loginPage("Something was wrong with that request. Please try again."));
    const username = (form.get("username") ?? "").trim().toLowerCase();
    const pw = form.get("password") ?? "";
    const code = (form.get("code") ?? "").replace(/\s+/g, "");
    const ip = clientIp(req, deps.trustProxy);

    try {
      const wait = await deps.limiter.blockedFor(username, ip);
      if (wait > 0) {
        logJson("warn", { event: "console_login_blocked", correlationId, outcome: "failure", context: { username, ip, retryAfterSeconds: wait } });
        await auditQuietly({ operator: username || "(blank)", action: "login", target: ip, outcome: "rejected", correlationId, detail: "locked_out" });
        const minutes = Math.max(1, Math.ceil(wait / 60));
        return html(res, 429, loginPage(`Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`, username), {
          "Retry-After": String(wait),
        });
      }

      const operator = await deps.operators.get(username);
      const passwordOk = await verifyPassword(pw, operator?.passwordHash || DUMMY_HASH);
      const step = operator && !operator.disabled && passwordOk ? matchTotp(operator.totpKey, code, now(), operator.lastTotpStep) : null;
      const accepted = step !== null && (await deps.operators.acceptTotpStep(username, step));

      if (!operator || !accepted) {
        await deps.limiter.recordFailure(username, ip);
        const reason = !operator ? FAIL.unknownUser : operator.disabled ? FAIL.disabled : !passwordOk ? FAIL.wrongPw : FAIL.badCode;
        logJson("warn", { event: "console_login_failed", correlationId, outcome: "failure", context: { username, ip, reason } });
        await auditQuietly({ operator: username || "(blank)", action: "login", target: ip, outcome: "failed", correlationId, detail: reason });
        return html(res, 401, loginPage(GENERIC_FAILURE, username));
      }

      // Audited before the session exists: if the audit log can't be written,
      // the sign-in fails (the catch below answers 503).
      await deps.audit.record({ operator: operator.username, action: "login", target: ip, outcome: "succeeded", correlationId });
      const { id } = await deps.sessions.create(operator.username, operator.role);
      logJson("info", { event: "console_login_succeeded", correlationId, outcome: "success", context: { username, role: operator.role, ip } });
      return redirect(res, "/console", { "Set-Cookie": sessionCookie(id, deps.cookieSecure, SESSION_IDLE_SECONDS) });
    } catch (error) {
      logJson("error", {
        event: "console_login_unavailable",
        correlationId,
        outcome: "failure",
        errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
        context: { username, ip },
      });
      return html(res, 503, loginPage("Sign-in is unavailable right now. Please try again in a few minutes.", username));
    }
  }

  return async (req, res, url) => {
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/console/login") {
      if (req.method === "GET") return html(res, 200, loginPage(null));
      if (req.method === "POST") return login(req, res);
      return html(res, 405, loginPage(null), { Allow: "GET, POST" });
    }

    const isApi = path.startsWith("/console/api/");
    const id = readCookie(req, SESSION_COOKIE);
    let session: Session | null = null;
    try {
      session = id ? await deps.sessions.touch(id) : null;
    } catch (error) {
      logJson("error", {
        event: "console_session_unavailable",
        correlationId: randomUUID(),
        outcome: "failure",
        errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
        context: { path },
      });
      return isApi ? json(res, 503, { error: "console unavailable" }) : html(res, 503, page({ title: "Unavailable | Relay Console", body: `<div class="card narrow"><h1>The console is unavailable right now</h1><p>Please try again in a few minutes.</p></div>` }));
    }
    if (!session) return isApi ? json(res, 401, { error: "sign in required" }) : redirect(res, "/console/login");

    if (req.method === "POST") {
      const form = await readForm(req);
      if (!form) return renderResult(res, session, { status: 400, message: "Something was wrong with that request. Please try again." });

      if (path === "/console/logout") {
        const correlationId = randomUUID();
        const integrity = checkIntegrity(req, session, form, deps.trustProxy);
        if (integrity) {
          await auditQuietly({ operator: session.username, action: "logout", target: "session", outcome: "rejected", correlationId, detail: integrity });
          return renderResult(res, session, { status: 403, message: "That request couldn't be verified. Reload the page and try again." });
        }
        await auditQuietly({ operator: session.username, action: "logout", target: "session", outcome: "succeeded", correlationId });
        await deps.sessions.destroy(id!);
        logJson("info", { event: "console_logout", correlationId, outcome: "success", context: { username: session.username } });
        return redirect(res, "/console/login", { "Set-Cookie": sessionCookie("", deps.cookieSecure, 0) });
      }

      const route = deps.postRoutes?.[path];
      if (route) {
        const target = route.target(form);
        if (!route.roles.includes(session.role)) {
          await auditQuietly({ operator: session.username, action: route.action, target, outcome: "rejected", correlationId: randomUUID(), detail: `role_${session.role}` });
          return renderResult(res, session, { status: 403, message: "Your role can't do that." });
        }
        const result = await deps.actions.perform({ req, session, form, action: route.action, target }, () => route.run(session, form));
        return renderResult(res, session, result);
      }
    }
    if (path === "/console" && req.method === "GET") return html(res, 200, homePage(session));
    if (path === "/console/audit" && req.method === "GET") {
      try {
        const entries = await deps.audit.recent(200, session.role === "engineer" ? undefined : session.username);
        return html(res, 200, auditPage(session, entries));
      } catch {
        return html(res, 503, page({ title: "Audit log | Relay Console", session, body: `<div class="card"><h1>Audit log</h1><p>The audit log can't be read right now. Please try again shortly.</p></div>` }));
      }
    }

    return isApi ? json(res, 404, { error: "not found" }) : html(res, 404, page({ title: "Not found | Relay Console", session, body: `<div class="card"><h1>Page not found</h1><p><a href="/console">Back to the console</a></p></div>` }));
  };
}
