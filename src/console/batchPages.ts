// STORY-104 (REQ-106): the batch screens, plugged into the console as an
// extension.
//
//   GET  /console/batches            list of batches (newest first)
//   GET  /console/batches/new        upload form (file picker fills a CSV box;
//                                    pasting works without JavaScript)
//   POST /console/batches/preview    validate, save a 1-hour draft, show row
//                                    errors; nothing is queued
//   POST /console/batches/submit     audited action: queue the draft's rows
//   GET  /console/batches/<id>       the batch (progress view grows in
//                                    STORY-105)
//   GET  /console/assets/upload.js   the small file-picker script
//
// Any operator can submit a batch; a draft can only be submitted by the
// operator who uploaded it.

import type { RedisStreamQueue } from "../queue.js";
import type { BatchResults } from "../batchResults.js";
import type { Session } from "./auth/sessions.js";
import { actionFields, esc, page } from "./layout.js";
import { checkCsv, MAX_FILE_BYTES, MAX_ROWS } from "./csv.js";
import { BatchBusyError, type BatchMeta, type BatchStore } from "./batches.js";
import type { ConsoleExtension, PageResult } from "./routes.js";

export interface BatchConsoleDeps {
  store: BatchStore;
  results: BatchResults;
  queue: RedisStreamQueue;
}

const SHOWN_ERRORS = 100;
// urlencoding can grow a 2 MB file up to ~3x (commas, quotes, non-ASCII).
const UPLOAD_BODY_LIMIT = MAX_FILE_BYTES * 3 + 64 * 1024;

export const UPLOAD_SCRIPT = `
(function () {
  var input = document.getElementById("file");
  var box = document.getElementById("csv");
  var name = document.getElementById("filename");
  var note = document.getElementById("file-note");
  if (!input || !box) return;
  input.addEventListener("change", function () {
    var file = input.files && input.files[0];
    if (!file) return;
    if (file.size > ${MAX_FILE_BYTES}) { note.textContent = "That file is larger than 2 MB. Split it into smaller batches."; input.value = ""; return; }
    var reader = new FileReader();
    reader.onload = function () { box.value = String(reader.result); name.value = file.name; note.textContent = "Loaded " + file.name + ". Check it below, then preview."; };
    reader.onerror = function () { note.textContent = "That file couldn't be read."; };
    reader.readAsText(file, "utf-8");
  });
})();
`;

function card(title: string, inner: string): string {
  return `<div class="card"><h1>${esc(title)}</h1>${inner}</div>`;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function newBatchPage(session: Session, message?: string): string {
  return page({
    title: "New batch | Relay Console",
    session,
    body: card(
      "New batch",
      `${message ? `<p class="error" role="alert">${esc(message)}</p>` : ""}
  <p>Upload a CSV with a header row and a column named <strong>text</strong> (one company or item per row). An optional <strong>id</strong> column is kept with each result. Up to ${fmt(MAX_ROWS)} rows and 2 MB, saved as UTF-8.</p>
  <form method="post" action="/console/batches/preview">
    ${actionFields(session)}
    <label for="file">CSV file</label>
    <input id="file" type="file" accept=".csv,text/csv">
    <p id="file-note" class="muted" aria-live="polite"></p>
    <input type="hidden" id="filename" name="filename" value="">
    <label for="csv">Or paste the CSV here</label>
    <textarea id="csv" name="csv" rows="10" required spellcheck="false" style="width:100%;font:13px/1.4 ui-monospace,monospace;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text)">text,id\n</textarea>
    <button class="full" type="submit">Check the file</button>
  </form>
  <script src="/console/assets/upload.js"></script>`
    ),
  });
}

function batchRow(meta: BatchMeta): string {
  const status = meta.status === "submitted" ? "Submitted" : `Submitting (${fmt(meta.queued)} of ${fmt(meta.total)} queued)`;
  return `<tr><td><a href="/console/batches/${esc(meta.batchId)}">${esc(meta.batchId)}</a></td><td>${esc(meta.filename || "pasted")}</td><td>${fmt(meta.total)}</td><td>${esc(meta.operator)}</td><td>${esc(status)}</td><td>${esc(meta.createdAt.replace("T", " ").slice(0, 16))}</td></tr>`;
}

export function batchConsole(deps: BatchConsoleDeps): ConsoleExtension {
  async function listPage(session: Session): Promise<PageResult> {
    const batches = await deps.store.list(0, 50);
    const rows = batches.map(batchRow).join("") || `<tr><td colspan="6">No batches yet.</td></tr>`;
    return {
      status: 200,
      html: page({
        title: "Batches | Relay Console",
        session,
        body: card(
          "Batches",
          `<p><a href="/console/batches/new">Upload a new batch</a></p>
  <div style="overflow-x:auto"><table><thead><tr><th scope="col">Batch</th><th scope="col">File</th><th scope="col">Rows</th><th scope="col">By</th><th scope="col">Status</th><th scope="col">Created (UTC)</th></tr></thead><tbody>${rows}</tbody></table></div>`
        ),
      }),
    };
  }

  async function detailPage(session: Session, batchId: string): Promise<PageResult> {
    const meta = await deps.store.meta(batchId);
    if (!meta) return { status: 404, html: page({ title: "Batch not found | Relay Console", session, body: card("Batch not found", `<p><a href="/console/batches">All batches</a></p>`) }) };
    const counts = await deps.results.counts(batchId);
    const waiting = Math.max(0, meta.total - counts.recorded);
    return {
      status: 200,
      html: page({
        title: `${meta.batchId} | Relay Console`,
        session,
        body: card(
          `Batch ${meta.batchId}`,
          `<p class="muted">${esc(meta.filename || "pasted CSV")} · ${fmt(meta.total)} rows · submitted by ${esc(meta.operator)}</p>
  ${meta.status === "submitting" ? `<p class="error" role="alert">Only ${fmt(meta.queued)} of ${fmt(meta.total)} rows were queued. Submit the batch again from its preview to queue the rest; nothing already queued will be queued twice.</p>` : ""}
  <table><tbody>
    <tr><th scope="row">Done</th><td>${fmt(counts.done)}</td></tr>
    <tr><th scope="row">Waiting</th><td>${fmt(waiting)}</td></tr>
    <tr><th scope="row">Waiting for review</th><td>${fmt(counts.review)}</td></tr>
    <tr><th scope="row">Failed</th><td>${fmt(counts.failed)}</td></tr>
  </tbody></table>
  <p><a href="/console/batches">All batches</a></p>`
        ),
      }),
    };
  }

  async function preview(session: Session, form: URLSearchParams): Promise<PageResult> {
    const content = form.get("csv") ?? "";
    const filename = (form.get("filename") ?? "").trim();
    const check = checkCsv(content);
    if (!check.ok) return { status: 422, html: newBatchPage(session, check.error) };
    if (check.rows.length === 0) return { status: 422, html: newBatchPage(session, `None of the ${fmt(check.totalRows)} rows can be used. Fix the rows listed and upload again.`) };

    const draft = await deps.store.createDraft(session.username, filename, check.rows, check.errors, check.totalRows);
    const errorRows = check.errors
      .slice(0, SHOWN_ERRORS)
      .map((e) => `<tr><td>${e.row}</td><td>${esc(e.reason)}</td></tr>`)
      .join("");
    const more = check.errors.length > SHOWN_ERRORS ? `<p class="muted">and ${fmt(check.errors.length - SHOWN_ERRORS)} more.</p>` : "";
    const sample = check.rows
      .slice(0, 5)
      .map((r) => `<tr><td>${r.row}</td><td>${esc(r.text.length > 120 ? `${r.text.slice(0, 117)}...` : r.text)}</td><td>${esc(r.ref ?? "")}</td></tr>`)
      .join("");
    return {
      status: 200,
      html: page({
        title: "Check batch | Relay Console",
        session,
        body: card(
          "Check before submitting",
          `<p><strong>${fmt(check.rows.length)}</strong> of ${fmt(check.totalRows)} rows are ready${filename ? ` from ${esc(filename)}` : ""}. Nothing has been queued yet.</p>
  ${
    check.errors.length
      ? `<p class="error" role="alert">${fmt(check.errors.length)} row${check.errors.length === 1 ? "" : "s"} can't be used and will be left out:</p>
  <div style="overflow-x:auto"><table><thead><tr><th scope="col">Row</th><th scope="col">Problem</th></tr></thead><tbody>${errorRows}</tbody></table></div>${more}`
      : ""
  }
  <h2 style="font-size:16px;margin:20px 0 8px">First rows</h2>
  <div style="overflow-x:auto"><table><thead><tr><th scope="col">Row</th><th scope="col">Text</th><th scope="col">Id</th></tr></thead><tbody>${sample}</tbody></table></div>
  <form method="post" action="/console/batches/submit">
    ${actionFields(session)}
    <input type="hidden" name="draft" value="${esc(draft.draftId)}">
    <button class="full" type="submit">Submit ${fmt(check.rows.length)} row${check.rows.length === 1 ? "" : "s"} as one batch</button>
  </form>
  <p class="muted">This check is kept for an hour. <a href="/console/batches/new">Start over</a></p>`
        ),
      }),
    };
  }

  return {
    assets: { "/console/assets/upload.js": { type: "text/javascript; charset=utf-8", body: UPLOAD_SCRIPT } },
    getRoutes: [
      { match: /^\/console\/batches$/, render: (session) => listPage(session) },
      { match: /^\/console\/batches\/new$/, render: async (session) => ({ status: 200, html: newBatchPage(session) }) },
      { match: /^\/console\/batches\/(b[0-9a-z]{6,20})$/, render: (session, m) => detailPage(session, m[1]) },
    ],
    uploadRoutes: {
      "/console/batches/preview": { maxBytes: UPLOAD_BODY_LIMIT, handle: preview },
    },
    postRoutes: {
      "/console/batches/submit": {
        action: "batch.submit",
        roles: ["analyst", "engineer"],
        target: async (form, session) => {
          const draft = await deps.store.getDraft(session.username, form.get("draft") ?? "");
          return draft ? `${draft.batchId} (${draft.rows.length} rows)` : `draft:${(form.get("draft") ?? "").slice(0, 32)}`;
        },
        run: async (session, form) => {
          const draft = await deps.store.getDraft(session.username, form.get("draft") ?? "");
          if (!draft) return { status: 410, message: "That check has expired or belongs to someone else. Upload the file again." };
          try {
            const meta = await deps.store.submit(draft, deps.queue);
            return { status: 303, location: `/console/batches/${meta.batchId}` };
          } catch (error) {
            if (error instanceof BatchBusyError) return { status: 409, message: "This batch is already being submitted. Give it a moment, then open Batches." };
            // Anything else, including BatchSubmitError (queued part of the
            // batch, then Redis refused more), is rethrown: ActionRunner
            // audits it as failed and releases the form key, so submitting
            // the same check again resumes where it stopped.
            throw error;
          }
        },
      },
    },
  };
}
