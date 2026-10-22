// STORY-101 (REQ-101, REQ-102): the console's HTTP entry point. Mounted by
// statusServer.ts for every /console path; everything else on the server
// (the public /status, /health, ...) is untouched and needs no login.
//
//   GET  /console/login   sign-in form
//   POST /console/login   password + authenticator code -> session cookie
//   POST /console/logout  ends the session
//   GET  /console         protected home
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
import { esc, page } from "./layout.js";

export const SESSION_COOKIE = "relay_session";
const MAX_BODY_BYTES = 8 * 1024;
// Internal log reasons only; the user always sees GENERIC_FAILURE.
const FAIL = { unknownUser: "unknown_user", disabled: "disabled", wrongPw: "bad_password", badCode: "bad_or_reused_code" } as const;
const GENERIC_FAILURE = "That username, password or code isn't right. Check them and try again.";

export interface ConsoleDeps {
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
  <p class="muted">Batches, review and failed jobs arrive in the next releases. Public status stays at <a href="/status">/status</a>.</p>
</div>`,
  });
}

export function createConsoleHandler(deps: ConsoleDeps): ConsoleHandler {
  const now = deps.now ?? Date.now;

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
        return html(res, 401, loginPage(GENERIC_FAILURE, username));
      }

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

    if (path === "/console/logout" && req.method === "POST") {
      await deps.sessions.destroy(id!);
      logJson("info", { event: "console_logout", correlationId: randomUUID(), outcome: "success", context: { username: session.username } });
      return redirect(res, "/console/login", { "Set-Cookie": sessionCookie("", deps.cookieSecure, 0) });
    }
    if (path === "/console" && req.method === "GET") return html(res, 200, homePage(session));

    return isApi ? json(res, 404, { error: "not found" }) : html(res, 404, page({ title: "Not found | Relay Console", session, body: `<div class="card"><h1>Page not found</h1><p><a href="/console">Back to the console</a></p></div>` }));
  };
}
