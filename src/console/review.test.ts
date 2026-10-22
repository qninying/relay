// STORY-106 over HTTP against REAL Redis. Review entries are made by the
// real worker code (handleBatchItem with a low-confidence classifier), so
// the console is tested against what workers actually write. Covers the
// three decisions, exactly-once under two simultaneous reviewers and
// double-clicks, the fixed taxonomy (forged labels, a changed taxonomy), a
// failed result update leaving the entry queued, an expired batch, and an
// entry that isn't from a batch. Skips cleanly if Redis isn't reachable.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Redis } from "ioredis";
import { AuditLog } from "./audit.js";
import { BatchStore } from "./batches.js";
import { batchConsole } from "./batchPages.js";
import { reviewConsole } from "./reviewPages.js";
import { ReviewItems } from "./reviewItems.js";
import { startConsole, type TestConsole } from "./testSupport.js";
import { BatchResults } from "../batchResults.js";
import { RedisStreamQueue } from "../queue.js";
import { RedisIdempotencyStore } from "../idempotencyStore.js";
import { handleBatchItem } from "../batchWorker.js";
import { cachedTaxonomy } from "../classifyJob.js";
import type { Taxonomy } from "../taxonomy.js";
import { parseCsv } from "./csv.js";

const redis = new Redis({ lazyConnect: true, retryStrategy: () => null, connectTimeout: 1000 });
let redisAvailable = false;
try {
  await redis.connect();
  await redis.ping();
  redisAvailable = true;
} catch {
  redisAvailable = false;
}
if (!redisAvailable) console.warn("[review.test.ts] Redis not reachable at localhost:6379, integration tests skipped.");

const RUN = Math.random().toString(36).slice(2, 8);
const P = `relay:test:review:${RUN}:`;
const REVIEW = `${P}review`;
const batchIds: string[] = [];

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (!redisAvailable) return;
  const keys = [...(await redis.keys(`${P}*`))];
  for (const id of batchIds) keys.push(`relay:batch:${id}:meta`, `relay:batch:${id}:items`, `relay:batch:${id}:inputs`);
  if (keys.length) await redis.del(...keys);
});

describe.skipIf(!redisAvailable)("review decisions (integration, real Redis, over HTTP)", () => {
  let c: TestConsole;
  const audit = new AuditLog(redis, `${P}audit`);
  const results = new BatchResults(redis, "relay:batch:");
  const store = new BatchStore(redis, P);
  const queue = new RedisStreamQueue(redis, `${P}jobs`, "g");
  const realTaxonomy = cachedTaxonomy();
  let taxonomyOverride: Taxonomy | null = null;

  beforeAll(async () => {
    await queue.ensureConsumerGroup();
    c = await startConsole(
      redis,
      P,
      audit,
      [
        batchConsole({ store, results, queue, audit, progressTtlMs: 0 }),
        reviewConsole({ items: new ReviewItems(redis, REVIEW), results, audit, getTaxonomy: async () => taxonomyOverride ?? realTaxonomy() }),
      ],
      { ana: "analyst", bob: "analyst", eve: "engineer" }
    );
  });
  afterAll(() => c.close());

  // A submitted batch whose items all go to review (classifier confidence 0.3).
  async function batchInReview(texts: string[]): Promise<{ batchId: string; entries: string[] }> {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const rows = texts.map((text, i) => ({ row: i + 1, text }));
    const draft = await store.createDraft("ana", "r.csv", rows, [], rows.length);
    batchIds.push(draft.batchId);
    await store.submit(draft, queue);
    const before = new Set(((await redis.xrange(REVIEW, "-", "+")) as [string, string[]][]).map(([id]) => id));
    for (const r of rows) {
      const job = { id: `${draft.batchId}-${r.row}`, correlationId: `corr-${draft.batchId}-${r.row}`, idempotencyKey: `${draft.batchId}-${r.row}`, payload: { batchId: draft.batchId, text: r.text, row: r.row } };
      await handleBatchItem(job, { batchId: draft.batchId, text: r.text }, {
        classifier: async () => ({ label: "other", confidence: 0.3 }),
        results,
        reviewStream: REVIEW,
        durableStore: new RedisIdempotencyStore(redis, `${P}widem:`),
      });
    }
    const entries = ((await redis.xrange(REVIEW, "-", "+")) as [string, string[]][]).map(([id]) => id).filter((id) => !before.has(id));
    return { batchId: draft.batchId, entries };
  }
  const decide = async (entry: string, fields: Record<string, string>, who = "ana") => c.post("/console/review/decide", { ...(await c.formFields(`/console/review/${entry}`, who)), entry, ...fields }, who);
  const queued = async (entry: string) => ((await redis.xrange(REVIEW, entry, entry)) as unknown[]).length === 1;
  const progress = async (batchId: string) => (await c.get(`/console/api/batches/${batchId}/progress`)).json();

  it("criterion 1: the queue lists the item, and its page shows the reason, input, model's label and confidence, and every taxonomy label", async () => {
    const { batchId, entries } = await batchInReview(["The Corner Bakery on Main St"]);
    const list = await (await c.get("/console/review")).text();
    expect(list).toContain(`href="/console/review/${entries[0]}"`);
    expect(list).toContain("The Corner Bakery on Main St");
    const pageHtml = await (await c.get(`/console/review/${entries[0]}`)).text();
    expect(pageHtml).toContain("The model&#39;s confidence (0.30) was below the review threshold (0.50).");
    expect(pageHtml).toContain('<td style="white-space:pre-wrap">The Corner Bakery on Main St</td>');
    expect(pageHtml).toContain("<strong>other</strong>");
    expect(pageHtml).toContain("industry version 1.0.0");
    expect(pageHtml).toContain(`href="/console/batches/${batchId}"`);
    const taxonomy = await realTaxonomy();
    for (const l of taxonomy.labels) expect(pageHtml).toContain(`<option value="${l.code}"`);
    expect(pageHtml).toContain('<option value="other" selected>');
  });

  it("criterion 2: approving and correcting update the batch result, take the item off the queue, count it as done, and are audited", async () => {
    const { batchId, entries } = await batchInReview(["Bakery one", "Clinic two"]);
    expect(await progress(batchId)).toMatchObject({ review: 2, done: 0 });

    const approve = await decide(entries[0], { decision: "approve" });
    expect(approve.status).toBe(303);
    expect(approve.headers.get("location")).toBe("/console/review");
    const correct = await decide(entries[1], { decision: "correct", label: "healthcare", note: "It's a clinic" }, "bob");
    expect(correct.status).toBe(303);

    expect(await queued(entries[0])).toBe(false);
    expect(await queued(entries[1])).toBe(false);
    expect(await results.get(batchId, `${batchId}-1`)).toMatchObject({ status: "done", label: "other", reviewDecision: "approved", reviewedBy: "ana" });
    expect(await results.get(batchId, `${batchId}-2`)).toMatchObject({ status: "done", label: "healthcare", reviewDecision: "corrected", reviewedBy: "bob", modelLabel: "other", note: "It's a clinic", taxonomyVersion: "1.0.0" });
    expect(await progress(batchId)).toMatchObject({ review: 0, done: 2, finished: true });

    const csv = parseCsv(await (await c.get(`/console/batches/${batchId}/results.csv`)).text());
    expect(csv[2]).toEqual(["2", "", "Clinic two", "done", "healthcare", "0.3", "1.0.0", "", "bob", "corrected", "It's a clinic", "other"]);

    const trail = (await audit.recent(100)).filter((e) => e.action === "review.decide" && e.target.startsWith(`${batchId}-2`));
    expect(trail.map((e) => e.outcome).sort()).toEqual(["performed", "succeeded"]);
    expect(trail.find((e) => e.outcome === "succeeded")).toMatchObject({ operator: "bob", detail: "corrected other to healthcare" });
  });

  it("criterion 3: rejecting needs a note, then records the item as rejected with the note and takes it off the queue", async () => {
    const { batchId, entries } = await batchInReview(["asdfgh"]);
    const noNote = await decide(entries[0], { decision: "reject" });
    expect(noNote.status).toBe(422);
    expect(await noNote.text()).toContain("Add a note saying why");
    expect(await queued(entries[0])).toBe(true);
    expect((await audit.recent(20)).find((e) => e.target === `${batchId}-1` && e.outcome === "rejected")!.detail).toContain("invalid: Add a note");

    expect((await decide(entries[0], { decision: "reject", note: "Not a company name" })).status).toBe(303);
    expect(await queued(entries[0])).toBe(false);
    expect(await results.get(batchId, `${batchId}-1`)).toMatchObject({ status: "rejected", note: "Not a company name", reviewDecision: "rejected", reviewedBy: "ana" });
    expect(await progress(batchId)).toMatchObject({ rejected: 1, review: 0, waiting: 0, finished: true });
    expect(await (await c.get(`/console/batches/${batchId}`)).text()).toContain('<td id="count-rejected">1</td>');
  });

  it("trust: two reviewers deciding the same item at the same moment get exactly one applied decision", async () => {
    const { batchId, entries } = await batchInReview(["Contested Co"]);
    const forms = await Promise.all([c.formFields(`/console/review/${entries[0]}`, "ana"), c.formFields(`/console/review/${entries[0]}`, "bob")]);
    const [a, b] = await Promise.all([
      c.post("/console/review/decide", { ...forms[0], entry: entries[0], decision: "correct", label: "software" }, "ana"),
      c.post("/console/review/decide", { ...forms[1], entry: entries[0], decision: "reject", note: "nope" }, "bob"),
    ]);
    expect([a.status, b.status].sort()).toEqual([303, 409]);
    const winner = a.status === 303 ? "ana" : "bob";
    const result = await results.get(batchId, `${batchId}-1`);
    expect(result).toMatchObject(winner === "ana" ? { status: "done", label: "software", reviewedBy: "ana" } : { status: "rejected", reviewedBy: "bob" });
    expect(await progress(batchId)).toMatchObject({ recorded: 1, review: 0 });
    // The loser found the entry already gone, so its result names the entry, not the job.
    const outcomes = (await audit.recent(100)).filter((e) => e.action === "review.decide" && (e.target.startsWith(`${batchId}-1`) || e.target === `entry:${entries[0]}`) && e.outcome !== "performed");
    expect(outcomes.map((e) => e.outcome).sort()).toEqual(["rejected", "succeeded"]);
    expect(outcomes.find((e) => e.outcome === "rejected")!.detail).toBe("gone");
  });

  it("trust: a decision from a page opened before the item was decided is refused and audited", async () => {
    const { batchId, entries } = await batchInReview(["Stale Page Co"]);
    const stale = await c.formFields(`/console/review/${entries[0]}`, "bob");
    expect((await decide(entries[0], { decision: "approve" }, "ana")).status).toBe(303);
    const late = await c.post("/console/review/decide", { ...stale, entry: entries[0], decision: "reject", note: "late" }, "bob");
    expect(late.status).toBe(409);
    expect(await late.text()).toContain("Someone has already decided this item");
    expect(await results.get(batchId, `${batchId}-1`)).toMatchObject({ status: "done", reviewedBy: "ana" });
    expect((await audit.recent(50)).find((e) => e.operator === "bob" && e.target === `entry:${entries[0]}` && e.outcome === "rejected")).toMatchObject({ detail: "gone" });
  });

  it("trust: an item that is no longer waiting for review is never overwritten by a leftover entry", async () => {
    const { batchId, entries } = await batchInReview(["Already Done Co"]);
    const done = { status: "done", label: "software", confidence: 0.9, taxonomyVersion: "1.0.0", at: new Date().toISOString() };
    await redis.hset(`relay:batch:${batchId}:items`, `${batchId}-1`, JSON.stringify(done));
    const res = await decide(entries[0], { decision: "reject", note: "should not land" });
    expect(res.status).toBe(409);
    expect(await results.get(batchId, `${batchId}-1`)).toEqual(done);
    expect(await queued(entries[0])).toBe(false);
  });

  it("trust: a double-clicked decision is applied once", async () => {
    const { batchId, entries } = await batchInReview(["Twice Inc"]);
    const form = { ...(await c.formFields(`/console/review/${entries[0]}`)), entry: entries[0], decision: "approve" };
    const [one, two] = await Promise.all([c.post("/console/review/decide", form), c.post("/console/review/decide", form)]);
    expect([one.status, two.status]).toContain(303);
    expect((await audit.recent(100)).filter((e) => e.target.startsWith(`${batchId}-1`) && e.outcome === "succeeded")).toHaveLength(1);
  });

  it("trust: a label outside the fixed taxonomy is refused and nothing changes", async () => {
    const { batchId, entries } = await batchInReview(["Forged Ltd"]);
    const res = await decide(entries[0], { decision: "correct", label: "crypto_casino" });
    expect(res.status).toBe(422);
    expect(await queued(entries[0])).toBe(true);
    expect(await results.get(batchId, `${batchId}-1`)).toMatchObject({ status: "review" });
  });

  it("failure path, taxonomy changed: the page says so, approving a removed label is refused, and a correction records both versions", async () => {
    const { batchId, entries } = await batchInReview(["Corner Bakery"]);
    const real = await realTaxonomy();
    const labels = [...real.labels.filter((l) => l.code !== "other"), { code: "food_and_beverage", name: "Food & Beverage", description: "" }];
    taxonomyOverride = { ...real, version: "2.0.0", labels, codes: new Set(labels.map((l) => l.code)) };
    try {
      expect(await (await c.get(`/console/review/${entries[0]}`)).text()).toContain("The taxonomy has changed since this item was classified (version 1.0.0; the labels below are version 2.0.0)");
      expect((await decide(entries[0], { decision: "approve" })).status).toBe(422);
      expect((await decide(entries[0], { decision: "correct", label: "food_and_beverage" })).status).toBe(303);
      expect(await results.get(batchId, `${batchId}-1`)).toMatchObject({ label: "food_and_beverage", taxonomyVersion: "2.0.0", modelLabel: "other", modelTaxonomyVersion: "1.0.0" });
    } finally {
      taxonomyOverride = null;
    }
  });

  it("failure path: if the result update fails, the item stays queued and undecided (nothing half-done), and a retry works", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { batchId, entries } = await batchInReview(["Fragile Co"]);
    const key = `relay:batch:${batchId}:items`;
    const saved = await redis.hgetall(key);
    await redis.del(key);
    await redis.set(key, "not a hash");
    const form = { ...(await c.formFields(`/console/review/${entries[0]}`)), entry: entries[0], decision: "approve" };
    expect((await c.post("/console/review/decide", form)).status).toBe(500);
    expect(await queued(entries[0])).toBe(true);
    await redis.del(key);
    await redis.hset(key, saved);
    expect(await results.get(batchId, `${batchId}-1`)).toMatchObject({ status: "review" });
    // ActionRunner released the form's key on failure, so the same form can be retried.
    expect((await c.post("/console/review/decide", form)).status).toBe(303);
    expect(await results.get(batchId, `${batchId}-1`)).toMatchObject({ status: "done", reviewDecision: "approved" });
  });

  it("failure path: an item whose batch has expired is removed from the queue with an explanation", async () => {
    const { batchId, entries } = await batchInReview(["Old Co"]);
    await redis.del(`relay:batch:${batchId}:items`);
    const res = await decide(entries[0], { decision: "approve" });
    expect(res.status).toBe(410);
    expect(await res.text()).toContain("batch has been deleted");
    expect(await queued(entries[0])).toBe(false);
  });

  it("an entry that isn't from a batch is listed but can't be decided; a missing item is 404; cross-site posts are refused", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = (await redis.xadd(REVIEW, "*", "data", JSON.stringify({ id: "plain-1", correlationId: "c", idempotencyKey: "plain-1", payload: { reason: "low_confidence", confidence: 0.2, threshold: 0.5, originalPayload: {} } })))!;
    expect(await (await c.get("/console/review")).text()).toContain("not a batch item");
    expect(await (await c.get(`/console/review/${id}`)).text()).toContain("can't be decided here yet");
    // That page has no form, so take the security fields from another page.
    const fields = await c.formFields("/console/batches/new");
    expect((await c.post("/console/review/decide", { ...fields, entry: id, decision: "approve" })).status).toBe(422);
    expect(await queued(id)).toBe(true);
    expect((await c.get("/console/review/1-0")).status).toBe(404);
    const form = { ...(await c.formFields("/console/batches/new")), entry: id, decision: "approve" };
    expect((await c.post("/console/review/decide", form, "ana", { origin: "https://evil.example" })).status).toBe(403);
    expect((await fetch(`${c.url}/console/review`, { redirect: "manual" })).status).toBe(303);
  });
});
