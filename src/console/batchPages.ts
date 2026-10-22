// STORY-104 (REQ-106): the batch screens, plugged into the console as an
// extension.
//
//   GET  /console/batches            list of batches (newest first, 50 a page)
//   GET  /console/batches/new        upload form (file picker fills a CSV box;
//                                    pasting works without JavaScript)
//   POST /console/batches/preview    validate, save a 1-hour draft, show row
//                                    errors; nothing is queued
//   POST /console/batches/submit     audited action: queue the draft's rows
//   GET  /console/assets/upload.js   the small file-picker script
//
// A batch's own page, progress and results download are in batchDetail.ts
// (STORY-105); batchConsole() serves both as one extension.
//
// Any operator can submit a batch; a draft can only be submitted by the
// operator who uploaded it.

import type { RedisStreamQueue } from "../queue.js";
import type { BatchResults } from "../batchResults.js";
import type { Session } from "./auth/sessions.js";
import type { AuditLog } from "./audit.js";
import { actionFields, card, esc, fmt, page, pageNumber, pager, PAGE_SIZE } from "./layout.js";
import { checkCsv, MAX_FILE_BYTES, MAX_ROWS } from "./csv.js";
import { BatchBusyError, type BatchMeta, type BatchStore } from "./batches.js";
import type { ConsoleExtension, PageResult } from "./routes.js";
import { batchDetail } from "./batchDetail.js";

export interface BatchConsoleDeps {
  store: BatchStore;
  results: BatchResults;
  queue: RedisStreamQueue;
  audit: AuditLog;
  // Shared count cache lifetime (batchDetail.ts); tests shorten it.
  progressTtlMs?: number;
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

function newBatchPage(session: Session, retentionDays: number, message?: string): string {
  return page({
    title: "New batch | Relay Console",
    session,
    body: card(
      "New batch",
      `${message ? `<p class="error" role="alert">${esc(message)}</p>` : ""}
  <p>Upload a CSV with a header row and a column named <strong>text</strong> (one company or item per row). An optional <strong>id</strong> column is kept with each result. Up to ${fmt(MAX_ROWS)} rows and 2 MB, saved as UTF-8. Batches and their results are deleted ${fmt(retentionDays)} days after they're submitted, so download what you need.</p>
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
  async function listPage(session: Session, url: URL): Promise<PageResult> {
    const total = await deps.store.count();
    const current = pageNumber(url, total);
    const batches = await deps.store.list((current - 1) * PAGE_SIZE, PAGE_SIZE);
    const rows = batches.map(batchRow).join("") || `<tr><td colspan="6">No batches yet.</td></tr>`;
    return {
      status: 200,
      html: page({
        title: "Batches | Relay Console",
        session,
        body: card(
          "Batches",
          `<p><a href="/console/batches/new">Upload a new batch</a></p>
  <div style="overflow-x:auto"><table><thead><tr><th scope="col">Batch</th><th scope="col">File</th><th scope="col">Rows</th><th scope="col">By</th><th scope="col">Status</th><th scope="col">Created (UTC)</th></tr></thead><tbody>${rows}</tbody></table></div>
  ${pager("/console/batches", current, total)}`
        ),
      }),
    };
  }

  async function preview(session: Session, form: URLSearchParams): Promise<PageResult> {
    const content = form.get("csv") ?? "";
    const filename = (form.get("filename") ?? "").trim();
    const check = checkCsv(content);
    if (!check.ok) return { status: 422, html: newBatchPage(session, deps.store.retentionDays, check.error) };
    if (check.rows.length === 0) return { status: 422, html: newBatchPage(session, deps.store.retentionDays, `None of the ${fmt(check.totalRows)} rows can be used. Fix the rows listed and upload again.`) };

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

  const detail = batchDetail(deps);
  return {
    ...detail,
    assets: { ...detail.assets, "/console/assets/upload.js": { type: "text/javascript; charset=utf-8", body: UPLOAD_SCRIPT } },
    getRoutes: [
      { match: /^\/console\/batches$/, render: (session, _m, url) => listPage(session, url) },
      { match: /^\/console\/batches\/new$/, render: async (session) => ({ status: 200, html: newBatchPage(session, deps.store.retentionDays) }) },
      ...(detail.getRoutes ?? []),
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
