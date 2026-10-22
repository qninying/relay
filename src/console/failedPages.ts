// STORY-107 (REQ-110): the failed jobs screens.
//
//   GET  /console/failed               failed jobs, oldest first, 50 a page,
//                                      with reason, class and time waited;
//                                      plus the most recent discards
//   GET  /console/failed/<messageId>   one job, and (engineers only) the
//                                      resubmit and discard forms
//   POST /console/failed/resubmit      audited action, engineers only
//   POST /console/failed/discard       audited action, engineers only, note
//                                      required
//
// Analysts see the same pages without the forms; a forged post from an
// analyst is refused (403) and audited as rejected by routes.ts. Notes are
// stored as typed and always shown escaped. If the failed-jobs stream
// can't be read, the page says so (503) rather than showing an empty list.

import type { AuditLog } from "./audit.js";
import type { Session } from "./auth/sessions.js";
import { actionFields, card, esc, fmt, page, PAGE_SIZE } from "./layout.js";
import type { FailedJob, FailedJobs } from "./failedJobs.js";
import type { ActionResult } from "./actions.js";
import type { ConsoleExtension, PageResult } from "./routes.js";
import { MESSAGE_ID } from "./reviewItems.js";
import { logJson } from "../logger.js";

export interface FailedConsoleDeps {
  failed: FailedJobs;
  audit: AuditLog;
  now?: () => number;
}

export const MAX_DISCARD_NOTE = 500;
const ID = MESSAGE_ID.source.slice(1, -1);
const GONE: ActionResult = { status: 409, message: "This job has already been resubmitted or discarded, so nothing was changed. Open Failed jobs to see what's left." };

export function waited(failedAt: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(failedAt)) / 60_000));
  if (Number.isNaN(minutes)) return "unknown";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} days`;
}

export function failedConsole(deps: FailedConsoleDeps): ConsoleExtension {
  const now = deps.now ?? Date.now;

  const unavailable = (session: Session): PageResult => ({
    status: 503,
    html: page({ title: "Failed jobs | Relay Console", session, body: card("Failed jobs", `<p role="alert">The failed jobs can't be read right now, so this isn't an empty list. Please try again shortly.</p>`) }),
  });

  async function readOr503<T>(session: Session, what: string, read: () => Promise<T>): Promise<T | PageResult> {
    try {
      return await read();
    } catch (error) {
      logJson("error", { event: "failed_jobs_unavailable", correlationId: session.username, outcome: "failure", errorClass: error instanceof Error ? error.constructor.name : "UnknownError", context: { what } });
      return unavailable(session);
    }
  }

  async function listPage(session: Session, url: URL): Promise<PageResult> {
    const after = url.searchParams.get("after") ?? undefined;
    const data = await readOr503(session, "list", () => Promise.all([deps.failed.list(PAGE_SIZE, after), deps.failed.count(), deps.failed.recentDiscards(10)]));
    if ("html" in data) return data;
    const [{ jobs, more }, total, discards] = data;
    const rows =
      jobs
        .map((j) => `<tr><td><a href="/console/failed/${esc(j.messageId)}">${esc(j.jobId)}</a></td><td>${esc(j.failureReason)}</td><td>${esc(j.failureClass)}</td><td>${esc(waited(j.failedAt, now()))}</td></tr>`)
        .join("") || `<tr><td colspan="4">No failed jobs are waiting.</td></tr>`;
    const nav = [after ? `<a href="/console/failed">First page</a>` : "", more ? `<a href="/console/failed?after=${esc(jobs[jobs.length - 1].messageId)}">Next</a>` : ""].filter(Boolean).join(" · ");
    const discardRows = discards.map((d) => `<tr><td>${esc(d.jobId)}</td><td>${esc(d.by)}</td><td>${esc(d.note)}</td><td>${esc(d.at.replace("T", " ").slice(0, 16))}</td></tr>`).join("");
    return {
      status: 200,
      html: page({
        title: "Failed jobs | Relay Console",
        session,
        body: card(
          "Failed jobs",
          `<p class="muted">${fmt(total)} job${total === 1 ? "" : "s"} that failed and need a person, oldest first.${session.role === "engineer" ? "" : " Only engineers can resubmit or discard them."}</p>
  <div style="overflow-x:auto"><table><thead><tr><th scope="col">Job</th><th scope="col">Failure reason</th><th scope="col">Class</th><th scope="col">Waiting</th></tr></thead><tbody>${rows}</tbody></table></div>
  ${nav ? `<nav aria-label="Pages" style="margin-top:12px">${nav}</nav>` : ""}
  ${discardRows ? `<h2 style="font-size:16px;margin:24px 0 8px">Recently discarded</h2><div style="overflow-x:auto"><table><thead><tr><th scope="col">Job</th><th scope="col">By</th><th scope="col">Note</th><th scope="col">When (UTC)</th></tr></thead><tbody>${discardRows}</tbody></table></div>` : ""}`
        ),
      }),
    };
  }

  async function jobPage(session: Session, messageId: string): Promise<PageResult> {
    const found = await readOr503(session, "job", async () => {
      const job = await deps.failed.get(messageId);
      return job ? { job, completed: await deps.failed.alreadyCompleted(job.idempotencyKey) } : null;
    });
    if (found && "html" in found) return found;
    if (!found) return { status: 404, html: page({ title: "Not waiting | Relay Console", session, body: card("Not waiting", `<p>This job has already been resubmitted or discarded, or doesn't exist.</p><p><a href="/console/failed">Failed jobs</a></p>`) }) };
    const { job, completed } = found;
    const payload = job.original ? JSON.stringify(job.original.payload, null, 2) : "";
    const forms =
      session.role !== "engineer"
        ? `<p class="muted">Only engineers can resubmit or discard failed jobs.</p>`
        : `${
            completed
              ? `<p class="error" role="alert">A job with this idempotency key has already completed, so resubmitting it would do nothing. Discard it instead.</p>`
              : job.original
                ? `<form method="post" action="/console/failed/resubmit">${actionFields(session)}<input type="hidden" name="entry" value="${esc(job.messageId)}"><button class="full" type="submit">Resubmit this job (same idempotency key)</button></form>`
                : `<p class="error">This entry doesn't contain the original job, so it can't be resubmitted.</p>`
          }
  <form method="post" action="/console/failed/discard">${actionFields(session)}<input type="hidden" name="entry" value="${esc(job.messageId)}">
    <label for="note">Why discard it? (required)</label>
    <textarea id="note" name="note" rows="3" required maxlength="${MAX_DISCARD_NOTE}" style="width:100%;font:inherit;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text)"></textarea>
    <button class="full" type="submit" style="background:var(--danger)">Discard this job</button>
  </form>`;
    return {
      status: 200,
      html: page({
        title: `${job.jobId} | Relay Console`,
        session,
        body: card(
          `Failed job ${job.jobId}`,
          `<table><tbody>
    <tr><th scope="row">Failure reason</th><td>${esc(job.failureReason)}</td></tr>
    <tr><th scope="row">Class</th><td>${esc(job.failureClass)}</td></tr>
    <tr><th scope="row">Failed at (UTC)</th><td>${esc(job.failedAt.replace("T", " ").slice(0, 19))}, waiting ${esc(waited(job.failedAt, now()))}</td></tr>
    <tr><th scope="row">Correlation ID</th><td>${esc(job.correlationId)}</td></tr>
    <tr><th scope="row">Idempotency key</th><td>${esc(job.idempotencyKey)}</td></tr>
  </tbody></table>
  ${payload ? `<h2 style="font-size:16px;margin:20px 0 8px">Payload</h2><pre style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px">${esc(payload.length > 4000 ? `${payload.slice(0, 3997)}...` : payload)}</pre>` : ""}
  ${forms}
  <p><a href="/console/failed">Failed jobs</a></p>`
        ),
      }),
    };
  }

  async function auditResult(session: Session, job: FailedJob | null, action: string, entry: string, applied: boolean, detail: string): Promise<void> {
    const correlationId = job?.correlationId ?? entry.slice(0, 45);
    await deps.audit
      .record({ operator: session.username, action, target: job ? job.jobId : `entry:${entry.slice(0, 45)}`, outcome: applied ? "succeeded" : "rejected", correlationId, detail })
      .catch((error) => logJson("error", { event: "console_audit_write_failed", correlationId, outcome: "failure", errorClass: error instanceof Error ? error.constructor.name : "UnknownError", context: { action } }));
    logJson(applied ? "info" : "warn", { event: applied ? `${action.replace(".", "_")}_applied` : `${action.replace(".", "_")}_refused`, correlationId, outcome: applied ? "success" : "failure", context: { operator: session.username, jobId: job?.jobId, detail } });
  }

  async function resubmit(session: Session, form: URLSearchParams): Promise<ActionResult> {
    const entry = form.get("entry") ?? "";
    const job = await deps.failed.get(entry);
    if (!job) return auditResult(session, null, "failed.resubmit", entry, false, "gone").then(() => GONE);
    if (!job.original) {
      await auditResult(session, job, "failed.resubmit", entry, false, "no_original_job");
      return { status: 422, message: "This entry doesn't contain the original job, so it can't be resubmitted. Discard it with a note instead." };
    }
    if (await deps.failed.alreadyCompleted(job.idempotencyKey)) {
      await auditResult(session, job, "failed.resubmit", entry, false, "already_completed");
      return { status: 409, message: "A job with this idempotency key has already completed, so it wasn't resubmitted. Discard it instead." };
    }
    const result = await deps.failed.resubmit(job);
    await auditResult(session, job, "failed.resubmit", entry, result === "applied", result === "applied" ? `key ${job.idempotencyKey}` : result);
    return result === "applied" ? { status: 303, location: "/console/failed" } : GONE;
  }

  async function discard(session: Session, form: URLSearchParams): Promise<ActionResult> {
    const entry = form.get("entry") ?? "";
    const note = (form.get("note") ?? "").trim();
    const job = await deps.failed.get(entry);
    if (!job) return auditResult(session, null, "failed.discard", entry, false, "gone").then(() => GONE);
    if (!note || note.length > MAX_DISCARD_NOTE) {
      await auditResult(session, job, "failed.discard", entry, false, note ? "note_too_long" : "no_note");
      return { status: 422, message: note ? `The note is ${fmt(note.length)} characters; the limit is ${MAX_DISCARD_NOTE}.` : "Add a note saying why the job is being discarded." };
    }
    const result = await deps.failed.discard(job, session.username, note);
    await auditResult(session, job, "failed.discard", entry, result === "applied", result === "applied" ? note : result);
    return result === "applied" ? { status: 303, location: "/console/failed" } : GONE;
  }

  // The audit names the job from the stream, never the form's own text.
  const target = async (form: URLSearchParams) => {
    const job = await deps.failed.get(form.get("entry") ?? "");
    return job ? `${job.jobId} (${job.failureClass})` : `entry:${(form.get("entry") ?? "").slice(0, 45)}`;
  };

  return {
    getRoutes: [
      { match: /^\/console\/failed$/, render: (session, _m, url) => listPage(session, url) },
      { match: new RegExp(`^/console/failed/(${ID})$`), render: (session, m) => jobPage(session, m[1]) },
    ],
    postRoutes: {
      "/console/failed/resubmit": { action: "failed.resubmit", roles: ["engineer"], target, run: resubmit },
      "/console/failed/discard": { action: "failed.discard", roles: ["engineer"], target, run: discard },
    },
  };
}
