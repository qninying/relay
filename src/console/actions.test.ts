// STORY-102 over HTTP against REAL Redis: every console action is audited
// before it's reported done, forged or cross-site requests are refused, and
// the same action can't be applied twice. Uses a test-only action (a
// counter) registered the same way later stories register theirs, so "was
// the action applied?" is just "did the counter move?". Skips cleanly if
// Redis isn't reachable.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Redis } from "ioredis";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OperatorStore } from "./auth/operators.js";
import { SessionStore } from "./auth/sessions.js";
import { LoginLimiter } from "./auth/loginLimiter.js";
import { hashPassword } from "./auth/password.js";
import { generateTotpSecret, stepAt, totpCodeForStep } from "./auth/totp.js";
import { AuditLog, AUDIT_RETENTION_MS } from "./audit.js";
import { ActionRunner } from "./actions.js";
import { actionFields } from "./layout.js";
import { createConsoleHandler, SESSION_COOKIE, type PostRoute } from "./routes.js";

const redis = new Redis({ lazyConnect: true, retryStrategy: () => null, connectTimeout: 1000 });
let redisAvailable = false;
try {
  await redis.connect();
  await redis.ping();
  redisAvailable = true;
} catch {
  redisAvailable = false;
}
if (!redisAvailable) console.warn("[actions.test.ts] Redis not reachable at localhost:6379, integration tests skipped.");

const RUN = Math.random().toString(36).slice(2, 8);
const P = `relay:test:actions:${RUN}:`;
const pw = "a-strong-test-pw";
const COUNTER = `${P}counter`;
let auditKey = `${P}audit`;
let failNextRun = false;

const routes: Record<string, PostRoute> = {
  "/console/test/increment": {
    action: "test.increment",
    roles: ["analyst", "engineer"],
    target: (form) => form.get("what") ?? "counter",
    run: async () => {
      if (failNextRun) {
        failNextRun = false;
        throw new RangeError("simulated failure inside the action");
      }
      const value = await redis.incr(COUNTER);
      return { status: 303, location: `/console?done=${value}` };
    },
  },
  "/console/test/engineers-only": {
    action: "test.engineers_only",
    roles: ["engineer"],
    target: () => "nothing",
    run: async () => {
      await redis.incr(`${COUNTER}:eng`);
      return { status: 303, location: "/console" };
    },
  },
};

function captureLogs() {
  const spies = (["log", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  return () => spies.flatMap((s) => s.mock.calls.map((c) => JSON.parse(c[0] as string) as Record<string, any>));
}

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (!redisAvailable) return;
  const keys = await redis.keys(`${P}*`);
  if (keys.length) await redis.del(...keys);
});

describe.skipIf(!redisAvailable)("console actions: audit, integrity, idempotency (integration, real Redis)", () => {
  let url: string;
  let server: http.Server;
  const keys: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  const csrf: Record<string, string> = {};
  let audit: AuditLog;

  beforeAll(async () => {
    audit = new AuditLog(redis, auditKey);
    const operators = new OperatorStore(redis, `${P}op:`);
    // The audit log the server uses is looked up per request, so a test can
    // point it at a broken key to simulate an audit outage.
    const liveAudit = new Proxy({} as AuditLog, { get: (_t, prop) => (new AuditLog(redis, auditKey) as any)[prop] });
    const handler = createConsoleHandler({
      audit: liveAudit,
      actions: new ActionRunner(redis, liveAudit, false, `${P}idem:`),
      postRoutes: routes,
      operators,
      sessions: new SessionStore(redis, `${P}sess:`),
      limiter: new LoginLimiter(redis, { prefix: `${P}fail:` }),
      cookieSecure: false,
      trustProxy: false,
    });
    server = http.createServer((req, res) => void handler(req, res, new URL(req.url ?? "/", "http://localhost")));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const [name, role] of [["ana", "analyst"], ["eng", "engineer"]] as const) {
      keys[name] = generateTotpSecret();
      await operators.create({ username: name, role, passwordHash: await hashPassword(pw), totpKey: keys[name] });
      const res = await fetch(`${url}/console/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: name, password: pw, code: totpCodeForStep(keys[name], stepAt(Date.now())) }).toString(),
        redirect: "manual",
      });
      cookies[name] = `${SESSION_COOKIE}=${res.headers.get("set-cookie")!.match(/relay_session=([^;]+)/)![1]}`;
      const home = await (await fetch(`${url}/console`, { headers: { cookie: cookies[name] } })).text();
      csrf[name] = home.match(/name="csrf" value="([^"]+)"/)![1];
    }
    vi.restoreAllMocks();
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const idem = () => `k${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  function post(path: string, who: string, fields: Record<string, string>, headers: Record<string, string> = { origin: url }) {
    return fetch(`${url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: cookies[who], ...headers },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
    });
  }
  const counter = async () => Number((await redis.get(COUNTER)) ?? 0);
  const auditFor = async (target: string) => (await audit.recent(500)).filter((e) => e.target === target);

  it("criterion 1: an action is audited (operator, time, action, target, outcome, correlation ID) before it's reported done", async () => {
    captureLogs();
    const before = await counter();
    const res = await post("/console/test/increment", "ana", { csrf: csrf.ana, idem: idem(), what: "c1" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/console?done=${before + 1}`);
    const entries = await auditFor("c1");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ operator: "ana", action: "test.increment", target: "c1", outcome: "performed" });
    expect(entries[0].correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(entries[0].at)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("criterion 2: a missing or wrong CSRF token is refused with 403, audited, and nothing happens", async () => {
    const before = await counter();
    expect((await post("/console/test/increment", "ana", { idem: idem(), what: "c2a" })).status).toBe(403);
    expect((await post("/console/test/increment", "ana", { csrf: csrf.eng, idem: idem(), what: "c2b" })).status).toBe(403);
    expect(await counter()).toBe(before);
    expect((await auditFor("c2a"))[0]).toMatchObject({ outcome: "rejected", detail: "bad_csrf" });
    expect((await auditFor("c2b"))[0]).toMatchObject({ outcome: "rejected", detail: "bad_csrf" });
  });

  it("criterion 2: a request from another origin (or with no origin at all) is refused even with a valid token", async () => {
    const before = await counter();
    expect((await post("/console/test/increment", "ana", { csrf: csrf.ana, idem: idem(), what: "c2c" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/console/test/increment", "ana", { csrf: csrf.ana, idem: idem(), what: "c2d" }, {})).status).toBe(403);
    expect(await counter()).toBe(before);
    expect((await auditFor("c2c"))[0]).toMatchObject({ outcome: "rejected", detail: "bad_origin" });
    // A same-origin Referer is accepted when Origin is absent (some browsers).
    expect((await post("/console/test/increment", "ana", { csrf: csrf.ana, idem: idem(), what: "c2e" }, { referer: `${url}/console` })).status).toBe(303);
    expect(await counter()).toBe(before + 1);
  });

  it("criterion 3: the same action submitted twice with the same key returns the first result and changes nothing", async () => {
    const key = idem();
    const before = await counter();
    const first = await post("/console/test/increment", "ana", { csrf: csrf.ana, idem: key, what: "c3" });
    const second = await post("/console/test/increment", "ana", { csrf: csrf.ana, idem: key, what: "c3" });
    expect(second.status).toBe(first.status);
    expect(second.headers.get("location")).toBe(first.headers.get("location"));
    expect(await counter()).toBe(before + 1);
    expect((await auditFor("c3")).map((e) => e.outcome).sort()).toEqual(["duplicate", "performed"]);
  });

  it("failure path, two tabs at the same moment: the action is applied exactly once", async () => {
    const key = idem();
    const before = await counter();
    const results = await Promise.all(Array.from({ length: 8 }, () => post("/console/test/increment", "ana", { csrf: csrf.ana, idem: key, what: "race" })));
    expect(await counter()).toBe(before + 1);
    for (const r of results) expect([303, 409]).toContain(r.status);
    expect((await auditFor("race")).filter((e) => e.outcome === "performed")).toHaveLength(1);
  });

  it("trust: if the audit log can't be written, the action is not performed, the operator is told, and a retry works once it's back", async () => {
    const logs = captureLogs();
    const key = idem();
    const before = await counter();
    const broken = `${P}audit-broken`;
    await redis.set(broken, "not a stream"); // XADD to a string key fails (WRONGTYPE)
    auditKey = broken;
    const res = await post("/console/test/increment", "ana", { csrf: csrf.ana, idem: key, what: "c4" });
    auditKey = `${P}audit`;
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("couldn&#39;t be recorded in the audit log");
    expect(await counter()).toBe(before);
    expect(logs().some((l) => l.event === "console_audit_write_failed")).toBe(true);

    const retry = await post("/console/test/increment", "ana", { csrf: csrf.ana, idem: key, what: "c4" });
    expect(retry.status).toBe(303);
    expect(await counter()).toBe(before + 1);
  });

  it("failure path: an action that throws is audited as failed and can be retried with the same key", async () => {
    const logs = captureLogs();
    const key = idem();
    const before = await counter();
    failNextRun = true;
    const res = await post("/console/test/increment", "ana", { csrf: csrf.ana, idem: key, what: "c5" });
    expect(res.status).toBe(500);
    expect(await counter()).toBe(before);
    expect((await auditFor("c5")).map((e) => e.outcome).sort()).toEqual(["failed", "performed"]);
    expect(logs().find((l) => l.event === "console_action_failed")).toMatchObject({ errorClass: "RangeError" });
    expect((await post("/console/test/increment", "ana", { csrf: csrf.ana, idem: key, what: "c5" })).status).toBe(303);
    expect(await counter()).toBe(before + 1);
  });

  it("roles: an analyst can't run an engineer-only action, and the attempt is audited", async () => {
    expect((await post("/console/test/engineers-only", "ana", { csrf: csrf.ana, idem: idem() })).status).toBe(403);
    expect(Number((await redis.get(`${COUNTER}:eng`)) ?? 0)).toBe(0);
    expect((await post("/console/test/engineers-only", "eng", { csrf: csrf.eng, idem: idem() })).status).toBe(303);
    expect(Number(await redis.get(`${COUNTER}:eng`))).toBe(1);
    const entries = (await audit.recent(500)).filter((e) => e.action === "test.engineers_only");
    expect(entries.map((e) => `${e.operator}:${e.outcome}`).sort()).toEqual(["ana:rejected", "eng:performed"]);
  });

  it("an idempotency key is scoped to its operator and must look like one", async () => {
    const key = idem();
    const before = await counter();
    await post("/console/test/increment", "ana", { csrf: csrf.ana, idem: key, what: "scope" });
    await post("/console/test/increment", "eng", { csrf: csrf.eng, idem: key, what: "scope" });
    expect(await counter()).toBe(before + 2);
    expect((await post("/console/test/increment", "ana", { csrf: csrf.ana, idem: "short", what: "bad-key" })).status).toBe(400);
  });

  it("sign-in, sign-out and forged sign-out are all in the audit log", async () => {
    const entries = await audit.recent(500);
    expect(entries.some((e) => e.action === "login" && e.operator === "ana" && e.outcome === "succeeded")).toBe(true);
    // Forged sign-out (no CSRF) is refused and the session survives.
    expect((await post("/console/logout", "eng", {})).status).toBe(403);
    expect((await fetch(`${url}/console`, { headers: { cookie: cookies.eng }, redirect: "manual" })).status).toBe(200);
    expect((await audit.recent(500)).some((e) => e.action === "logout" && e.operator === "eng" && e.outcome === "rejected")).toBe(true);
  });

  it("the audit page: engineers see everyone's events, analysts only their own", async () => {
    const engPage = await (await fetch(`${url}/console/audit`, { headers: { cookie: cookies.eng } })).text();
    const anaPage = await (await fetch(`${url}/console/audit`, { headers: { cookie: cookies.ana } })).text();
    expect(engPage).toContain("<td>ana</td>");
    expect(engPage).toContain("<td>eng</td>");
    expect(anaPage).toContain("<td>ana</td>");
    expect(anaPage).not.toContain("<td>eng</td>");
    expect(engPage).toContain("Every operator's");
  });

  it("forms rendered by the console carry a CSRF token and a fresh one-time key each time", () => {
    const session = { username: "ana", role: "analyst" as const, createdAt: "", csrfToken: "tok" };
    const a = actionFields(session);
    const b = actionFields(session);
    expect(a).toContain('name="csrf" value="tok"');
    expect(a.match(/name="idem" value="([^"]+)"/)![1]).not.toBe(b.match(/name="idem" value="([^"]+)"/)![1]);
  });

  it("the audit log keeps 90 days and trims older entries as new ones arrive", async () => {
    const key = `${P}audit-retention`;
    const old = Date.now() - AUDIT_RETENTION_MS - 60_000;
    await redis.xadd(key, `${old}-0`, "action", "ancient");
    await redis.xadd(key, `${Date.now() - 1000}-0`, "action", "recent");
    await new AuditLog(redis, key).record({ operator: "eng", action: "new", target: "t", outcome: "succeeded", correlationId: "c" });
    const remaining = ((await redis.xrange(key, "-", "+")) as [string, string[]][]).map(([, f]) => f[f.indexOf("action") + 1]);
    expect(remaining).toEqual(["recent", "new"]);
  });
});
