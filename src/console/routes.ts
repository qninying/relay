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
//   to the sign-in form, /console/api/* answers 401 JSON. A GET under
//   /console/api/ (background polling) does not extend the session.
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
import { auditPage, homePage, loginPage } from "./corePages.js";
import { clientIp, HEADERS, html, json, readCookie, readForm, redirect, sessionCookie, SESSION_COOKIE, stream, type Download } from "./http.js";

export { SESSION_COOKIE, type Download };
// Internal log reasons only; the user always sees GENERIC_FAILURE.
const FAIL = { unknownUser: "unknown_user", disabled: "disabled", wrongPw: "bad_password", badCode: "bad_or_reused_code" } as const;
const GENERIC_FAILURE = "That username, password or code isn't right. Check them and try again.";

// A state-changing console action, registered by a later story (batch
// submit, review decision, ...). Always run through ActionRunner.perform.
export interface PostRoute {
  action: string;
  roles: Role[];
  // What the audit entry names as the target. May look things up (e.g. the
  // batch a draft belongs to), so the audit never trusts a form's own label.
  target: (form: URLSearchParams, session: Session) => string | Promise<string>;
  run: (session: Session, form: URLSearchParams) => Promise<ActionResult>;
}

export interface PageResult {
  status: number;
  html: string;
}

// A page added by a later story, e.g. /console/batches/<id>.
export interface GetRoute {
  match: RegExp;
  render: (session: Session, match: RegExpMatchArray, url: URL) => Promise<PageResult>;
}

// A POST that changes nothing lasting but needs a larger body (an upload
// preview). Same-origin + CSRF checked; not an audited action.
export interface UploadRoute {
  maxBytes: number;
  handle: (session: Session, form: URLSearchParams) => Promise<PageResult>;
}

// A small JSON read under /console/api/ (e.g. batch progress, polled).
export interface ApiRoute {
  match: RegExp;
  handle: (session: Session, match: RegExpMatchArray) => Promise<{ status: number; body: unknown }>;
}

export interface DownloadRoute {
  match: RegExp;
  handle: (session: Session, match: RegExpMatchArray) => Promise<Download | PageResult>;
}

// What a console feature (batches, review, failed jobs) plugs in.
export interface ConsoleExtension {
  // Static scripts/styles the pages load (same origin, so the CSP allows them).
  assets?: Record<string, { type: string; body: string }>;
  getRoutes?: GetRoute[];
  apiRoutes?: ApiRoute[];
  downloadRoutes?: DownloadRoute[];
  postRoutes?: Record<string, PostRoute>;
  uploadRoutes?: Record<string, UploadRoute>;
}

export interface ConsoleDeps {
  audit: AuditLog;
  actions: ActionRunner;
  postRoutes?: Record<string, PostRoute>;
  extensions?: ConsoleExtension[];
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


export function createConsoleHandler(deps: ConsoleDeps): ConsoleHandler {
  const now = deps.now ?? Date.now;
  const extensions = deps.extensions ?? [];
  const postRoutes: Record<string, PostRoute> = Object.assign({}, deps.postRoutes, ...extensions.map((e) => e.postRoutes ?? {}));
  const uploadRoutes: Record<string, UploadRoute> = Object.assign({}, ...extensions.map((e) => e.uploadRoutes ?? {}));
  const getRoutes: GetRoute[] = extensions.flatMap((e) => e.getRoutes ?? []);
  const apiRoutes: ApiRoute[] = extensions.flatMap((e) => e.apiRoutes ?? []);
  const downloadRoutes: DownloadRoute[] = extensions.flatMap((e) => e.downloadRoutes ?? []);
  const assets: Record<string, { type: string; body: string }> = Object.assign({}, ...extensions.map((e) => e.assets ?? {}));

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
    const heading = result.status < 400 ? "Done" : "That didn't go through";
    return html(res, result.status, page({ title: `${heading} | Relay Console`, session, body: `<div class="card"><h1>${esc(heading)}</h1><p role="alert">${esc(result.message ?? "")}</p><p><a href="/console">Back to the console</a></p></div>` }));
  }

  async function login(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const correlationId = randomUUID();
    const form = await readForm(req);
    if (!form) return html(res, 400, loginPage("Something was wrong with that request. Please try again."), { Connection: "close" });
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
      const background = isApi && req.method === "GET";
      session = id ? await (background ? deps.sessions.peek(id) : deps.sessions.touch(id)) : null;
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
      const upload = uploadRoutes[path];
      const form = await readForm(req, upload?.maxBytes);
      if (!form) {
        // The rest of the body was never read. Close the connection after
        // this response, or a keep-alive client (or proxy) would send its
        // next request down a socket still holding unread upload bytes.
        res.setHeader("Connection", "close");
        const tooBig = upload ? "That file is too large. The limit is 2 MB." : "Something was wrong with that request. Please try again.";
        return renderResult(res, session, { status: upload ? 413 : 400, message: tooBig });
      }

      if (upload) {
        const integrity = checkIntegrity(req, session, form, deps.trustProxy);
        if (integrity) return renderResult(res, session, { status: 403, message: "That request couldn't be verified. Reload the page and try again." });
        const result = await upload.handle(session, form);
        return html(res, result.status, result.html);
      }

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

      const route = postRoutes[path];
      if (route) {
        const target = await route.target(form, session);
        if (!route.roles.includes(session.role)) {
          await auditQuietly({ operator: session.username, action: route.action, target, outcome: "rejected", correlationId: randomUUID(), detail: `role_${session.role}` });
          return renderResult(res, session, { status: 403, message: "Your role can't do that." });
        }
        const result = await deps.actions.perform({ req, session, form, action: route.action, target }, () => route.run(session, form));
        return renderResult(res, session, result);
      }
    }
    if (req.method === "GET") {
      const asset = assets[path];
      if (asset) {
        res.writeHead(200, { "Content-Type": asset.type, ...HEADERS });
        return void res.end(asset.body);
      }
      for (const route of getRoutes) {
        const match = path.match(route.match);
        if (match) {
          const result = await route.render(session, match, url);
          return html(res, result.status, result.html);
        }
      }
      // The plain home page, unless an extension (the overview) provides one.
      if (path === "/console") return html(res, 200, homePage(session));
      for (const route of apiRoutes) {
        const match = path.match(route.match);
        if (match) {
          const result = await route.handle(session, match);
          return json(res, result.status, result.body);
        }
      }
      for (const route of downloadRoutes) {
        const match = path.match(route.match);
        if (match) {
          const result = await route.handle(session, match);
          return "chunks" in result ? stream(res, result, randomUUID()) : html(res, result.status, result.html);
        }
      }
    }
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
