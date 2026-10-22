// STORY-105 (REQ-107, REQ-113): following a batch and downloading its
// results.
//
//   GET /console/batches/<id>                  counts + items, a page at a time
//   GET /console/api/batches/<id>/progress     counts as JSON, polled every 5s
//   GET /console/batches/<id>/results.csv      the results, streamed, audited
//   GET /console/assets/progress.js            the polling script
//
// Trust: counts and item statuses are both read from the batch's result
// hash (BatchResults), never kept separately, so they can't disagree. Any
// operator may open any batch, but opening someone else's batch is audited
// (batch.view), and every download is audited (batch.download) before the
// first byte is sent; if the audit can't be written, neither happens.
//
// Load: polls go through ProgressCache (one count per batch per 2 seconds,
// however many tabs), the script polls every 5 seconds, pauses while the
// tab is hidden, backs off on errors and stops once the batch is finished.

import { randomUUID } from "node:crypto";
import type { BatchResults, BatchCounts } from "../batchResults.js";
import type { AuditLog } from "./audit.js";
import type { Session } from "./auth/sessions.js";
import { card, esc, fmt, page, pageNumber, pager, PAGE_SIZE } from "./layout.js";
import type { BatchMeta, BatchStore } from "./batches.js";
import { ProgressCache } from "./progressCache.js";
import { csvLine, RESULTS_HEADER, resultLine, statusLabel } from "./resultsCsv.js";
import type { ConsoleExtension, Download, PageResult } from "./routes.js";
import { logJson } from "../logger.js";

export interface BatchDetailDeps {
  store: BatchStore;
  results: BatchResults;
  audit: AuditLog;
  progressTtlMs?: number;
}

export interface Progress extends BatchCounts {
  status: BatchMeta["status"];
  total: number;
  queued: number;
  waiting: number;
  finished: boolean;
}

const BATCH_ID = "(b[0-9a-z]{6,20})";
const EXPORT_CHUNK = 500;

export const PROGRESS_SCRIPT = `
(function () {
  var root = document.getElementById("progress");
  if (!root || !window.fetch || root.getAttribute("data-finished") === "true") return;
  var src = root.getAttribute("data-src");
  var note = document.getElementById("progress-note");
  var fields = ["done", "waiting", "review", "failed"];
  var delay = 5000, timer = null, busy = false, stopped = false;
  function schedule() { timer = setTimeout(poll, delay); }
  function poll() {
    timer = null;
    if (stopped || busy) return;
    if (document.hidden) return;
    busy = true;
    fetch(src, { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (r) {
        if (r.status === 401) { stopped = true; note.textContent = "Your session has ended. Reload the page to sign in again."; return null; }
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (p) {
        busy = false;
        if (!p) return;
        fields.forEach(function (f) { var el = document.getElementById("count-" + f); if (el) el.textContent = Number(p[f]).toLocaleString("en-US"); });
        delay = 5000;
        if (p.finished) { stopped = true; note.textContent = "Finished. Every item has a result."; return; }
        note.textContent = "Updated " + new Date().toLocaleTimeString() + ". Refreshes every few seconds.";
        schedule();
      })
      .catch(function () {
        busy = false;
        delay = Math.min(delay * 2, 60000);
        note.textContent = "Couldn't refresh the counts. Trying again shortly.";
        schedule();
      });
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden && timer === null) poll(); });
  schedule();
})();
`;

function itemsTable(rows: string): string {
  return `<div style="overflow-x:auto"><table><thead><tr><th scope="col">Row</th><th scope="col">Id</th><th scope="col">Input</th><th scope="col">Status</th><th scope="col">Label</th><th scope="col">Confidence</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function batchDetail(deps: BatchDetailDeps): ConsoleExtension {
  const progress = new ProgressCache<Progress | null>(async (batchId) => {
    const meta = await deps.store.meta(batchId);
    if (!meta) return null;
    const counts = await deps.results.counts(batchId);
    const waiting = Math.max(0, meta.total - counts.recorded);
    return { ...counts, status: meta.status, total: meta.total, queued: meta.queued, waiting, finished: meta.status === "submitted" && waiting === 0 };
  }, deps.progressTtlMs);

  // Audit first: someone else's batch is shown only if the view is recorded.
  async function auditView(session: Session, meta: BatchMeta): Promise<boolean> {
    if (session.username === meta.operator) return true;
    try {
      await deps.audit.record({ operator: session.username, action: "batch.view", target: `${meta.batchId} (by ${meta.operator})`, outcome: "performed", correlationId: randomUUID() });
      return true;
    } catch (error) {
      logJson("error", { event: "console_audit_write_failed", correlationId: meta.batchId, outcome: "failure", errorClass: error instanceof Error ? error.constructor.name : "UnknownError", context: { operator: session.username, action: "batch.view" } });
      return false;
    }
  }

  const unavailable = (session: Session, what: string): PageResult => ({
    status: 503,
    html: page({ title: "Unavailable | Relay Console", session, body: card("Not available right now", `<p>${esc(what)} can't be shown because the audit log can't be written. Please try again shortly.</p>`) }),
  });
  const notFound = (session: Session): PageResult => ({ status: 404, html: page({ title: "Batch not found | Relay Console", session, body: card("Batch not found", `<p><a href="/console/batches">All batches</a></p>`) }) });

  async function detailPage(session: Session, batchId: string, url: URL): Promise<PageResult> {
    const meta = await deps.store.meta(batchId);
    if (!meta) return notFound(session);
    if (!(await auditView(session, meta))) return unavailable(session, "This batch");
    const p = (await progress.get(batchId))!;
    const itemTotal = await deps.store.itemCount(batchId);
    const current = pageNumber(url, itemTotal);
    const inputs = await deps.store.items(batchId, (current - 1) * PAGE_SIZE, PAGE_SIZE);
    const outcomes = await deps.results.getMany(batchId, inputs.map((i) => i.jobId));
    const rows = inputs
      .map((input, i) => {
        const o = outcomes[i];
        const text = input.text.length > 120 ? `${input.text.slice(0, 117)}...` : input.text;
        return `<tr><td>${input.row}</td><td>${esc(input.ref ?? "")}</td><td>${esc(text)}</td><td>${esc(statusLabel(o))}</td><td>${esc(o?.label ?? "")}</td><td>${o?.confidence === undefined ? "" : o.confidence.toFixed(2)}</td></tr>`;
      })
      .join("");
    const items =
      itemTotal > 0
        ? `${itemsTable(rows)}${pager(`/console/batches/${batchId}`, current, itemTotal)}
  <p><a href="/console/batches/${esc(batchId)}/results.csv">Download results (CSV)</a></p>`
        : `<p class="muted">Item details weren't kept for this batch: it was submitted before item lists were added.</p>`;
    return {
      status: 200,
      html: page({
        title: `${meta.batchId} | Relay Console`,
        session,
        body: card(
          `Batch ${meta.batchId}`,
          `<p class="muted">${esc(meta.filename || "pasted CSV")} · ${fmt(meta.total)} rows · submitted by ${esc(meta.operator)}${meta.expiresAt ? ` · kept until ${esc(meta.expiresAt.slice(0, 10))}, then deleted` : ""}</p>
  ${meta.status === "submitting" ? `<p class="error" role="alert">Only ${fmt(meta.queued)} of ${fmt(meta.total)} rows were queued. Submit the batch again from its preview to queue the rest; nothing already queued will be queued twice.</p>` : ""}
  <div id="progress" data-src="/console/api/batches/${esc(batchId)}/progress" data-finished="${p.finished}">
  <table><tbody>
    <tr><th scope="row">Done</th><td id="count-done">${fmt(p.done)}</td></tr>
    <tr><th scope="row">Waiting</th><td id="count-waiting">${fmt(p.waiting)}</td></tr>
    <tr><th scope="row">Waiting for review</th><td id="count-review">${fmt(p.review)}</td></tr>
    <tr><th scope="row">Failed</th><td id="count-failed">${fmt(p.failed)}</td></tr>
  </tbody></table>
  <p id="progress-note" class="muted" aria-live="polite">${p.finished ? "Finished. Every item has a result." : "Refreshes every few seconds."}</p>
  </div>
  <h2 style="font-size:16px;margin:20px 0 8px">Items</h2>
  ${items}
  <p><a href="/console/batches">All batches</a></p>
  <script src="/console/assets/progress.js"></script>`
        ),
      }),
    };
  }

  async function* exportChunks(batchId: string, itemTotal: number): AsyncGenerator<string> {
    yield `﻿${csvLine(RESULTS_HEADER)}`;
    for (let offset = 0; offset < itemTotal; offset += EXPORT_CHUNK) {
      const inputs = await deps.store.items(batchId, offset, EXPORT_CHUNK);
      const outcomes = await deps.results.getMany(batchId, inputs.map((i) => i.jobId));
      yield inputs.map((input, i) => resultLine(input, outcomes[i])).join("");
    }
  }

  async function download(session: Session, batchId: string): Promise<Download | PageResult> {
    const meta = await deps.store.meta(batchId);
    if (!meta) return notFound(session);
    const itemTotal = await deps.store.itemCount(batchId);
    const correlationId = randomUUID();
    try {
      await deps.audit.record({ operator: session.username, action: "batch.download", target: `${batchId} (${itemTotal} rows)`, outcome: "performed", correlationId });
    } catch (error) {
      logJson("error", { event: "console_audit_write_failed", correlationId, outcome: "failure", errorClass: error instanceof Error ? error.constructor.name : "UnknownError", context: { operator: session.username, action: "batch.download" } });
      return unavailable(session, "The download");
    }
    logJson("info", { event: "batch_results_downloaded", correlationId, outcome: "success", context: { batchId, operator: session.username, rows: itemTotal } });
    return { filename: `relay-${batchId}-results.csv`, type: "text/csv; charset=utf-8", chunks: exportChunks(batchId, itemTotal) };
  }

  return {
    assets: { "/console/assets/progress.js": { type: "text/javascript; charset=utf-8", body: PROGRESS_SCRIPT } },
    getRoutes: [{ match: new RegExp(`^/console/batches/${BATCH_ID}$`), render: (session, m, url) => detailPage(session, m[1], url) }],
    apiRoutes: [
      {
        match: new RegExp(`^/console/api/batches/${BATCH_ID}/progress$`),
        handle: async (_session, m) => {
          try {
            const p = await progress.get(m[1]);
            return p ? { status: 200, body: p } : { status: 404, body: { error: "batch not found" } };
          } catch (error) {
            logJson("error", { event: "batch_progress_unavailable", correlationId: m[1], outcome: "failure", errorClass: error instanceof Error ? error.constructor.name : "UnknownError", context: { batchId: m[1] } });
            return { status: 503, body: { error: "progress unavailable" } };
          }
        },
      },
    ],
    downloadRoutes: [{ match: new RegExp(`^/console/batches/${BATCH_ID}/results\\.csv$`), handle: (session, m) => download(session, m[1]) }],
  };
}
