// Test helper: a real console handler over HTTP against real Redis, with
// signed-in operators. Used by the console integration tests.

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Redis } from "ioredis";
import { vi } from "vitest";
import { OperatorStore, type Role } from "./auth/operators.js";
import { SessionStore } from "./auth/sessions.js";
import { LoginLimiter } from "./auth/loginLimiter.js";
import { hashPassword } from "./auth/password.js";
import { generateTotpSecret, stepAt, totpCodeForStep } from "./auth/totp.js";
import type { AuditLog } from "./audit.js";
import { ActionRunner } from "./actions.js";
import { createConsoleHandler, SESSION_COOKIE, type ConsoleExtension } from "./routes.js";

export interface TestConsole {
  url: string;
  close: () => Promise<void>;
  get: (path: string, who?: string) => Promise<Response>;
  post: (path: string, fields: Record<string, string>, who?: string, headers?: Record<string, string>) => Promise<Response>;
  // The session cookie value for an operator (e.g. to give a browser).
  sessionId: (who: string) => string;
  // csrf + a fresh idem key, read from a rendered page's form.
  formFields: (path: string, who?: string) => Promise<{ csrf: string; idem: string }>;
}

export async function startConsole(redis: Redis, prefix: string, audit: AuditLog, extensions: ConsoleExtension[], people: Record<string, Role>): Promise<TestConsole> {
  const operators = new OperatorStore(redis, `${prefix}op:`);
  const handler = createConsoleHandler({
    audit,
    actions: new ActionRunner(redis, audit, false, `${prefix}idem:`),
    extensions,
    operators,
    sessions: new SessionStore(redis, `${prefix}sess:`),
    limiter: new LoginLimiter(redis, { prefix: `${prefix}fail:` }),
    cookieSecure: false,
    trustProxy: false,
  });
  const server = http.createServer((req, res) => void handler(req, res, new URL(req.url ?? "/", "http://localhost")));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const cookies: Record<string, string> = {};
  const quiet = vi.spyOn(console, "log").mockImplementation(() => {});
  const pw = "a-strong-test-pw";
  for (const [name, role] of Object.entries(people)) {
    const key = generateTotpSecret();
    await operators.create({ username: name, role, passwordHash: await hashPassword(pw), totpKey: key });
    const res = await fetch(`${url}/console/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: name, password: pw, code: totpCodeForStep(key, stepAt(Date.now())) }).toString(),
      redirect: "manual",
    });
    cookies[name] = `${SESSION_COOKIE}=${res.headers.get("set-cookie")!.match(/relay_session=([^;]+)/)![1]}`;
  }
  quiet.mockRestore();

  const first = Object.keys(people)[0];
  const get = (path: string, who = first) => fetch(`${url}${path}`, { headers: { cookie: cookies[who] }, redirect: "manual" });
  return {
    url,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    sessionId: (who) => cookies[who].split("=")[1],
    get,
    post: (path, fields, who = first, headers = { origin: url }) =>
      fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: cookies[who], ...headers }, body: new URLSearchParams(fields).toString(), redirect: "manual" }),
    formFields: async (path, who = first) => {
      const body = await (await get(path, who)).text();
      return { csrf: body.match(/name="csrf" value="([^"]+)"/)![1], idem: body.match(/name="idem" value="([^"]+)"/)![1] };
    },
  };
}
