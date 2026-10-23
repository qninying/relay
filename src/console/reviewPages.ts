// STORY-106 (REQ-108, REQ-109): deciding items the model wasn't sure about.
//
//   GET  /console/review                 the queue, oldest first, 50 a page
//   GET  /console/review/<messageId>     one item: reason, input, the model's
//                                        label and confidence, and the
//                                        taxonomy's labels to choose from
//   POST /console/review/decide          audited action: approve, correct or
//                                        reject (a note is required to reject)
//
// Exactly once: the decision is applied by BatchResults.resolveReview, one
// Lua step that updates the batch result and removes the review entry, so
// two reviewers deciding the same item at once get one applied decision and
// one "already decided". The form's one-time key (ActionRunner) stops a
// double-click from even trying twice.
//
// Fixed taxonomy: a correction must be a code from the currently loaded,
// hash-pinned taxonomy, and approving keeps the model's label only if that
// label still exists in it. When the taxonomy has changed since the item
// was classified, the page says so and the result records both versions.
//
// Any operator (analyst or engineer) may review.

import type { BatchResults, ItemOutcome, ResolveOutcome } from "../batchResults.js";
import { OutputContractViolation } from "../batchResults.js";
import type { Taxonomy } from "../taxonomy.js";
import type { AuditLog } from "./audit.js";
import type { Session } from "./auth/sessions.js";
import { actionFields, card, esc, fmt, page, PAGE_SIZE } from "./layout.js";
import { MESSAGE_ID, type ReviewItem, type ReviewItems } from "./reviewItems.js";
import type { ActionResult } from "./actions.js";
import type { ConsoleExtension, PageResult } from "./routes.js";
import { logJson } from "../logger.js";

export interface ReviewConsoleDeps {
  items: ReviewItems;
  results: BatchResults;
  audit: AuditLog;
  getTaxonomy: () => Promise<Taxonomy>;
}

export const MAX_NOTE_CHARS = 500;

export type DecisionCheck = { ok: true; outcome: ItemOutcome; summary: string } | { ok: false; status: number; message: string };

// Turns a submitted form into the item's new outcome, or says why not.
export function buildDecision(item: ReviewItem, form: URLSearchParams, taxonomy: Taxonomy, reviewer: string, now: Date): DecisionCheck {
  const batch = item.batch;
  if (!batch) return { ok: false, status: 422, message: "This item isn't from a batch, so it can't be decided here yet." };
  const decision = form.get("decision") ?? "";
  const note = (form.get("note") ?? "").trim();
  if (note.length > MAX_NOTE_CHARS) return { ok: false, status: 422, message: `The note is ${fmt(note.length)} characters; the limit is ${MAX_NOTE_CHARS}.` };
  const base = { confidence: item.confidence ?? 0, at: now.toISOString(), reviewedBy: reviewer, ...(note ? { note } : {}) };

  if (decision === "approve") {
    if (!taxonomy.codes.has(batch.label))
      return { ok: false, status: 422, message: `"${batch.label}" isn't a label in taxonomy version ${taxonomy.version} any more. Choose a current label and save it as a correction.` };
    return { ok: true, summary: `approved ${batch.label}`, outcome: { status: "done", label: batch.label, taxonomyVersion: batch.taxonomyVersion, reviewDecision: "approved", ...base } };
  }
  if (decision === "correct") {
    const label = form.get("label") ?? "";
    if (!taxonomy.codes.has(label)) return { ok: false, status: 422, message: "Choose a label from the taxonomy." };
    if (label === batch.label && batch.taxonomyVersion === taxonomy.version) return { ok: false, status: 422, message: "That's the model's own label. Use Approve to accept it." };
    const versions = batch.taxonomyVersion === taxonomy.version ? {} : { modelTaxonomyVersion: batch.taxonomyVersion };
    return { ok: true, summary: `corrected ${batch.label} to ${label}`, outcome: { status: "done", label, taxonomyVersion: taxonomy.version, reviewDecision: "corrected", modelLabel: batch.label, ...versions, ...base } };
  }
  if (decision === "reject") {
    if (!note) return { ok: false, status: 422, message: "Add a note saying why the item is rejected." };
    return { ok: true, summary: "rejected", outcome: { status: "rejected", label: batch.label, taxonomyVersion: batch.taxonomyVersion, reviewDecision: "rejected", ...base, note } };
  }
  return { ok: false, status: 400, message: "Choose approve, correct or reject." };
}

const RESOLVED: Record<Exclude<ResolveOutcome, "applied">, ActionResult> = {
  gone: { status: 409, message: "Someone has already decided this item, so your decision wasn't applied. Open the review queue to see what's left." },
  batch_deleted: { status: 410, message: "This item's batch has been deleted (batches are kept for a limited time), so there was nothing to update. The review item has been removed." },
  not_waiting: { status: 409, message: "This item isn't waiting for review any more, so nothing was changed. Its leftover review entry has been removed." },
};

function reasonText(item: ReviewItem): string {
  if (item.reason === "low_confidence" && item.confidence !== undefined && item.threshold !== undefined)
    return `The model's confidence (${item.confidence.toFixed(2)}) was below the review threshold (${item.threshold.toFixed(2)}).`;
  if (item.reason === "ungrounded_summary") return "The summary didn't match its source text.";
  return item.reason;
}

const short = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 3)}...` : text);

export function reviewConsole(deps: ReviewConsoleDeps): ConsoleExtension {
  async function listPage(session: Session, url: URL): Promise<PageResult> {
    const after = url.searchParams.get("after") ?? undefined;
    const [{ items, more }, total] = await Promise.all([deps.items.list(PAGE_SIZE, after), deps.items.count()]);
    const rows =
      items
        .map((i) => {
          const b = i.batch;
          const where = b ? `<a href="/console/batches/${esc(b.batchId)}">${esc(b.batchId)}</a>${b.row ? ` row ${b.row}` : ""}` : `<span class="muted">not a batch item</span>`;
          return `<tr><td><a href="/console/review/${esc(i.messageId)}">Review</a></td><td>${where}</td><td>${esc(short(b?.text ?? i.jobId, 80))}</td><td>${esc(b?.label ?? "")}</td><td>${i.confidence === undefined ? "" : i.confidence.toFixed(2)}</td><td>${esc(i.routedAt.replace("T", " ").slice(0, 16))}</td></tr>`;
        })
        .join("") || `<tr><td colspan="6">Nothing is waiting for review.</td></tr>`;
    const nav = [after ? `<a href="/console/review">First page</a>` : "", more ? `<a href="/console/review?after=${esc(items[items.length - 1].messageId)}">Next</a>` : ""].filter(Boolean).join(" · ");
    return {
      status: 200,
      html: page({
        title: "Review | Relay Console",
        session,
        body: card(
          "Waiting for review",
          `<p class="muted">${fmt(total)} item${total === 1 ? "" : "s"} the model wasn't sure about, oldest first. Times are UTC.</p>
  <div style="overflow-x:auto"><table><thead><tr><th scope="col"></th><th scope="col">Batch</th><th scope="col">Input</th><th scope="col">Model's label</th><th scope="col">Confidence</th><th scope="col">Waiting since</th></tr></thead><tbody>${rows}</tbody></table></div>
  ${nav ? `<nav aria-label="Pages" style="margin-top:12px">${nav}</nav>` : ""}`
        ),
      }),
    };
  }

  async function itemPage(session: Session, messageId: string): Promise<PageResult> {
    const item = await deps.items.get(messageId);
    if (!item) return { status: 404, html: page({ title: "Not waiting | Relay Console", session, body: card("Not waiting for review", `<p>This item has already been decided or doesn't exist.</p><p><a href="/console/review">Review queue</a></p>`) }) };
    const b = item.batch;
    let taxonomy: Taxonomy;
    try {
      taxonomy = await deps.getTaxonomy();
    } catch (error) {
      logJson("error", { event: "review_taxonomy_unavailable", correlationId: item.correlationId, outcome: "failure", errorClass: error instanceof Error ? error.constructor.name : "UnknownError", context: { messageId } });
      return { status: 503, html: page({ title: "Unavailable | Relay Console", session, body: card("Can't review right now", `<p>The taxonomy couldn't be loaded, so no labels can be offered. Please try again shortly.</p>`) }) };
    }
    const name = (code: string) => taxonomy.labels.find((l) => l.code === code)?.name ?? "not in the current taxonomy";
    const details = b
      ? `<table><tbody>
    <tr><th scope="row">Batch</th><td><a href="/console/batches/${esc(b.batchId)}">${esc(b.batchId)}</a>${b.row ? `, row ${b.row}` : ""}${b.ref ? ` (id ${esc(b.ref)})` : ""}</td></tr>
    <tr><th scope="row">Input</th><td style="white-space:pre-wrap">${esc(b.text)}</td></tr>
    <tr><th scope="row">Model's label</th><td><strong>${esc(b.label)}</strong> (${esc(name(b.label))})</td></tr>
    <tr><th scope="row">Confidence</th><td>${item.confidence === undefined ? "unknown" : item.confidence.toFixed(2)}</td></tr>
    <tr><th scope="row">Taxonomy</th><td>${esc(b.taxonomyId)} version ${esc(b.taxonomyVersion)}</td></tr>
  </tbody></table>`
      : `<p>Job ${esc(item.jobId)} isn't from a batch, so there's no batch result to update. It can't be decided here yet.</p>`;
    const changed = b && b.taxonomyVersion !== taxonomy.version ? `<p class="error" role="alert">The taxonomy has changed since this item was classified (version ${esc(b.taxonomyVersion)}; the labels below are version ${esc(taxonomy.version)}). A correction is recorded against version ${esc(taxonomy.version)}.</p>` : "";
    const options = taxonomy.labels.map((l) => `<option value="${esc(l.code)}"${b?.label === l.code ? " selected" : ""}>${esc(l.name)} (${esc(l.code)})</option>`).join("");
    const form = b
      ? `<form method="post" action="/console/review/decide">
    ${actionFields(session)}
    <input type="hidden" name="entry" value="${esc(item.messageId)}">
    <label for="label">Correct label</label>
    <select id="label" name="label" style="width:100%;font:inherit;padding:10px 12px;border:1px solid var(--field-border);border-radius:8px;background:var(--bg);color:var(--text)">${options}</select>
    <label for="note">Note (required to reject)</label>
    <textarea id="note" name="note" rows="3" maxlength="${MAX_NOTE_CHARS}" style="width:100%;font:inherit;padding:10px;border:1px solid var(--field-border);border-radius:8px;background:var(--bg);color:var(--text)"></textarea>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:20px">
      <button type="submit" name="decision" value="approve">Approve "${esc(b.label)}"</button>
      <button type="submit" name="decision" value="correct">Save the correct label</button>
      <button type="submit" name="decision" value="reject" style="background:var(--danger)">Reject</button>
    </div>
  </form>`
      : "";
    return {
      status: 200,
      html: page({
        title: "Review an item | Relay Console",
        session,
        body: card("Review an item", `<p>${esc(reasonText(item))}</p>${changed}${details}${form}<p><a href="/console/review">Review queue</a></p>`),
      }),
    };
  }

  // The outcome of every decision attempt that got past ActionRunner, so
  // its "performed" entry is never left without a result.
  async function auditResult(session: Session, target: string, correlationId: string, applied: boolean, detail: string): Promise<void> {
    await deps.audit
      .record({ operator: session.username, action: "review.decide", target, outcome: applied ? "succeeded" : "rejected", correlationId, detail })
      .catch((error) => logJson("error", { event: "console_audit_write_failed", correlationId, outcome: "failure", errorClass: error instanceof Error ? error.constructor.name : "UnknownError", context: { action: "review.decide" } }));
  }

  async function decide(session: Session, form: URLSearchParams): Promise<ActionResult> {
    const entry = form.get("entry") ?? "";
    const item = await deps.items.get(entry);
    if (!item) {
      await auditResult(session, `entry:${entry.slice(0, 45)}`, entry.slice(0, 45), false, "gone");
      return RESOLVED.gone;
    }
    const check = buildDecision(item, form, await deps.getTaxonomy(), session.username, new Date());
    if (!check.ok) {
      await auditResult(session, item.jobId, item.correlationId, false, `invalid: ${check.message}`);
      return { status: check.status, message: check.message };
    }
    let result: ResolveOutcome;
    try {
      result = await deps.results.resolveReview(item.batch!.batchId, item.jobId, deps.items.stream, item.messageId, check.outcome);
    } catch (error) {
      if (!(error instanceof OutputContractViolation)) throw error;
      return { status: 422, message: "That note can't be saved as written. Rephrase it and try again." };
    }
    await auditResult(session, item.jobId, item.correlationId, result === "applied", result === "applied" ? check.summary : result);
    logJson("info", { event: "review_decided", correlationId: item.correlationId, outcome: result === "applied" ? "success" : "failure", context: { jobId: item.jobId, reviewer: session.username, result, decision: check.summary } });
    return result === "applied" ? { status: 303, location: "/console/review" } : RESOLVED[result];
  }

  return {
    getRoutes: [
      { match: /^\/console\/review$/, render: (session, _m, url) => listPage(session, url) },
      { match: new RegExp(`^/console/review/(${MESSAGE_ID.source.slice(1, -1)})$`), render: (session, m) => itemPage(session, m[1]) },
    ],
    postRoutes: {
      "/console/review/decide": {
        action: "review.decide",
        roles: ["analyst", "engineer"],
        // The audit names the item from the queue, never the form's own text.
        target: async (form) => {
          const item = await deps.items.get(form.get("entry") ?? "");
          return item ? `${item.jobId} (${form.get("decision") ?? "?"})` : `entry:${(form.get("entry") ?? "").slice(0, 45)}`;
        },
        run: decide,
      },
    },
  };
}
