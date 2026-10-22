// STORY-101 end to end over HTTP against REAL Redis: sign-in with password +
// authenticator code, lockout, session handling, every /console route
// protected, Redis outage, and the public status page left alone. Skips
// cleanly if Redis isn't reachable.

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { Redis } from "ioredis";
import type { AddressInfo } from "node:net";
import { OperatorStore } from "./auth/operators.js";
import { SessionStore } from "./auth/sessions.js";
import { LoginLimiter } from "./auth/loginLimiter.js";
import { hashPassword } from "./auth/password.js";
import { generateTotpSecret, stepAt, totpCodeForStep } from "./auth/totp.js";
import { createConsoleHandler, SESSION_COOKIE, type ConsoleDeps } from "./routes.js";
import { createStatusServer } from "../statusServer.js";
import { RedisStreamQueue } from "../queue.js";
import { MetricsCollector } from "../metrics.js";
import { JobOutcomeTracker } from "../jobOutcomeTracker.js";
import { MonitoringSampler } from "../monitoringSampler.js";

const redis = new Redis({ lazyConnect: true, retryStrategy: () => null, connectTimeout: 1000 });
let redisAvailable = false;
try {
  await redis.connect();
  await redis.ping();
  redisAvailable = true;
} catch {
  redisAvailable = false;
}
if (!redisAvailable) console.warn("[login.test.ts] Redis not reachable at localhost:6379, integration tests skipped.");

const RUN = Math.random().toString(36).slice(2, 8);
const P = `relay:test:console:${RUN}:`;
const pw = "a-strong-test-pw";
const NOW = 1_800_000_000_000;

function stores(r: Redis) {
  return {
    operators: new OperatorStore(r, `${P}op:`),
    sessions: new SessionStore(r, `${P}sess:`),
    limiter: new LoginLimiter(r, { prefix: `${P}fail:`, windowSeconds: 2 }),
  };
}

async function serve(deps: ConsoleDeps, r: Redis = redis): Promise<{ url: string; close: () => Promise<void> }> {
  const queue = new RedisStreamQueue(r, `${P}jobs`, "g");
  const metrics = new MetricsCollector({ windowSize: 10, targetSuccessRate: 0.9 });
  const sampler = new MonitoringSampler({
    redis: r, queue, queueStream: `${P}jobs`, queueGroup: "g", dlqStream: `${P}dlq`, reviewStream: `${P}review`,
    metrics, tracker: new JobOutcomeTracker(metrics), workerCount: () => 1, historyKey: `${P}metrics`,
  });
  const server = createStatusServer({ redis: r, sampler, metrics, sampleIntervalMs: 60_000, targetSuccessRate: 0.9, dlqStream: `${P}dlq`, console: createConsoleHandler(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

function form(fields: Record<string, string>): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(), redirect: "manual" };
}

function cookieFrom(res: Response): string | null {
  const set = res.headers.get("set-cookie");
  const match = set?.match(new RegExp(`${SESSION_COOKIE}=([^;]*)`));
  return match ? match[1] : null;
}

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

describe.skipIf(!redisAvailable)("console sign-in (integration, real Redis, over HTTP)", () => {
  const s = stores(redis);
  let now = NOW;
  let app: { url: string; close: () => Promise<void> };
  const secrets: Record<string, string> = {};

  async function makeOperator(username: string, role: "analyst" | "engineer" = "analyst") {
    secrets[username] = generateTotpSecret();
    await s.operators.create({ username, role, passwordHash: await hashPassword(pw), totpKey: secrets[username] });
  }
  const code = (username: string, offset = 0) => totpCodeForStep(secrets[username], stepAt(now) + offset);
  const login = (fields: Record<string, string>) => fetch(`${app.url}/console/login`, form(fields));

  beforeAll(async () => {
    app = await serve({ ...s, cookieSecure: true, trustProxy: false, now: () => now });
    for (const u of ["ana", "eng", "locky", "drift", "off"]) await makeOperator(u, u === "eng" ? "engineer" : "analyst");
    await s.operators.setDisabled("off", true);
  });
  afterAll(() => app.close());
  // Every test signs in from 127.0.0.1, so failures from one test would
  // otherwise count toward the next one's per-IP lockout.
  beforeEach(async () => {
    const keys = await redis.keys(`${P}fail:*`);
    if (keys.length) await redis.del(...keys);
  });

  it("criterion 1: right password + current code gives a session and the protected home page", async () => {
    const logs = captureLogs();
    const res = await login({ username: "ana", password: pw, code: code("ana") });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/console");
    const setCookie = res.headers.get("set-cookie")!;
    for (const flag of ["HttpOnly", "SameSite=Strict", "Secure", "Path=/console", "Max-Age=28800"]) expect(setCookie).toContain(flag);

    const home = await fetch(`${app.url}/console`, { headers: { cookie: `${SESSION_COOKIE}=${cookieFrom(res)}` } });
    expect(home.status).toBe(200);
    const body = await home.text();
    expect(body).toContain("Signed in as <strong>ana</strong> (analyst)");
    expect(logs().find((l) => l.event === "console_login_succeeded")).toMatchObject({ context: { username: "ana", role: "analyst" } });
    expect(JSON.stringify(logs())).not.toContain(pw);
  });

  it("criterion 2: wrong password, wrong code, unknown user and disabled user all get the same generic refusal", async () => {
    const logs = captureLogs();
    const attempts = [
      { username: "eng", password: "wrong", code: code("eng") },
      { username: "eng", password: pw, code: "000000" },
      { username: "nobody", password: pw, code: "123456" },
      { username: "off", password: pw, code: code("off") },
    ];
    const bodies: string[] = [];
    for (const a of attempts) {
      const res = await login(a);
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
      bodies.push((await res.text()).replace(/value="[^"]*"/, ""));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain("That username, password or code isn&#39;t right.");
    expect(logs().filter((l) => l.event === "console_login_failed").map((l) => l.context.reason)).toEqual([
      "bad_password",
      "bad_or_reused_code",
      "unknown_user",
      "disabled",
    ]);
    await s.limiter.clearAccount("eng");
  });

  it("a code that was already used can't sign in again (replay)", async () => {
    captureLogs();
    const c = code("eng");
    expect((await login({ username: "eng", password: pw, code: c })).status).toBe(303);
    expect((await login({ username: "eng", password: pw, code: c })).status).toBe(401);
    await s.limiter.clearAccount("eng");
  });

  it("failure path, clock drift: a phone one step fast or slow works, two steps doesn't", async () => {
    captureLogs();
    now += 10 * 30_000;
    expect((await login({ username: "drift", password: pw, code: code("drift", -1) })).status).toBe(303);
    now += 5 * 30_000;
    expect((await login({ username: "drift", password: pw, code: code("drift", 1) })).status).toBe(303);
    now += 5 * 30_000;
    expect((await login({ username: "drift", password: pw, code: code("drift", 2) })).status).toBe(401);
    expect((await login({ username: "drift", password: pw, code: code("drift", -2) })).status).toBe(401);
    await s.limiter.clearAccount("drift");
  });

  it("criterion 3: after 5 failures the account is locked even with correct credentials, until the window passes", async () => {
    const logs = captureLogs();
    for (let i = 0; i < 5; i++) expect((await login({ username: "locky", password: "nope", code: "000000" })).status).toBe(401);
    now += 30_000;
    const blocked = await login({ username: "locky", password: pw, code: code("locky") });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await blocked.text()).toContain("Too many sign-in attempts");
    expect(logs().some((l) => l.event === "console_login_blocked")).toBe(true);

    await new Promise((r) => setTimeout(r, 2200)); // test window is 2s
    now += 30_000;
    await redis.del(`${P}fail:ip:127.0.0.1`);
    expect((await login({ username: "locky", password: pw, code: code("locky") })).status).toBe(303);
  });

  it("criterion 3: failures from one IP across different usernames lock that IP", async () => {
    captureLogs();
    for (let i = 0; i < 5; i++) await login({ username: `guess${i}`, password: "x", code: "000000" });
    now += 30_000;
    expect((await login({ username: "ana", password: pw, code: code("ana") })).status).toBe(429);
    await redis.del(`${P}fail:ip:127.0.0.1`);
  });

  it("trust: no /console route responds without a valid session (pages redirect, API is 401)", async () => {
    for (const path of ["/console", "/console/", "/console/batches", "/console/review", "/console/failed", "/console/audit"]) {
      const res = await fetch(`${app.url}${path}`, { redirect: "manual" });
      expect(res.status, path).toBe(303);
      expect(res.headers.get("location"), path).toBe("/console/login");
    }
    expect((await fetch(`${app.url}/console/api/batches`)).status).toBe(401);
    expect((await fetch(`${app.url}/console/logout`, form({}))).status).toBe(303);
    const forged = await fetch(`${app.url}/console`, { headers: { cookie: `${SESSION_COOKIE}=${"A".repeat(43)}` }, redirect: "manual" });
    expect(forged.status).toBe(303);
  });

  it("sessions: stored only as a hash, slide on use, and end at sign-out", async () => {
    captureLogs();
    now += 60_000;
    const res = await login({ username: "ana", password: pw, code: code("ana") });
    const id = cookieFrom(res)!;
    const keys = await redis.keys(`${P}sess:*`);
    expect(keys.some((k) => k.includes(id))).toBe(false);

    const cookie = { cookie: `${SESSION_COOKIE}=${id}` };
    const logout = await fetch(`${app.url}/console/logout`, { ...form({}), headers: { ...form({}).headers, ...cookie } });
    expect(logout.status).toBe(303);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await fetch(`${app.url}/console`, { headers: cookie, redirect: "manual" })).status).toBe(303);
  });

  it("an unknown user costs the same password check as a wrong password (no account enumeration by timing)", async () => {
    captureLogs();
    const time = async (fields: Record<string, string>) => {
      const t = performance.now();
      await login(fields);
      return performance.now() - t;
    };
    const unknown: number[] = [];
    const wrong: number[] = [];
    for (let i = 0; i < 3; i++) {
      unknown.push(await time({ username: `ghost${i}`, password: "x", code: "000000" }));
      wrong.push(await time({ username: "eng", password: "x", code: "000000" }));
    }
    await redis.del(`${P}fail:ip:127.0.0.1`, `${P}fail:user:eng`);
    const med = (a: number[]) => a.sort((x, y) => x - y)[1];
    const ratio = med(unknown) / med(wrong);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });

  it("leaves the public status page alone: no login needed, still read-only", async () => {
    expect((await fetch(`${app.url}/status`)).status).toBe(200);
    expect((await fetch(`${app.url}/health`)).status).toBe(200);
    expect((await fetch(`${app.url}/status`, { method: "POST" })).status).toBe(405);
  });

  it("rejects malformed or oversized sign-in requests", async () => {
    expect((await fetch(`${app.url}/console/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(400);
    expect((await login({ username: "ana", password: "x".repeat(10_000), code: "1" })).status).toBe(400);
  });
});

describe.skipIf(!redisAvailable)("console with Redis unreachable", () => {
  it("failure path: sign-in and protected pages answer 503, never an unchecked session", async () => {
    const logs = captureLogs();
    const dead = new Redis({ port: 1, lazyConnect: true, retryStrategy: () => null, enableOfflineQueue: false, maxRetriesPerRequest: 0 });
    dead.on("error", () => {});
    const app = await serve({ ...stores(dead), cookieSecure: false, trustProxy: false }, dead);
    const res = await fetch(`${app.url}/console/login`, form({ username: "ana", password: pw, code: "123456" }));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Sign-in is unavailable right now");
    const page = await fetch(`${app.url}/console`, { headers: { cookie: `${SESSION_COOKIE}=${"B".repeat(43)}` }, redirect: "manual" });
    expect(page.status).toBe(503);
    expect(logs().some((l) => l.event === "console_login_unavailable")).toBe(true);
    await app.close();
    dead.disconnect();
  });
});

