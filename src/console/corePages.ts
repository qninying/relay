// The console's own pages (split out of routes.ts): sign-in, home and the
// audit log. Feature screens live with their features (batchPages.ts, ...).

import type { Session } from "./auth/sessions.js";
import type { AuditLog } from "./audit.js";
import { esc, page } from "./layout.js";

export function loginPage(message: string | null, username = ""): string {
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

export function homePage(session: Session): string {
  return page({
    title: "Relay Console",
    session,
    body: `<div class="card">
  <h1>Welcome, ${esc(session.username)}</h1>
  <p>You're signed in to the Relay console as ${session.role === "engineer" ? "an engineer" : "an analyst"}.</p>
  <p><a href="/console/batches">Batches</a>: upload a CSV and follow it.</p>
  <p><a href="/console/review">Review</a>: decide the items the model wasn't sure about.</p>
  <p><a href="/console/failed">Failed jobs</a>: jobs that failed and need a person${session.role === "engineer" ? "; resubmit or discard them" : " (engineers act on them)"}.</p>
  <p><a href="/console/audit">Audit log</a>: every sign-in and action, who did it and when.</p>
  <p class="muted">Public status stays at <a href="/status">/status</a>.</p>
</div>`,
  });
}

export function auditPage(session: Session, entries: Awaited<ReturnType<AuditLog["recent"]>>): string {
  const rows = entries
    .map(
      (e) => `<tr><td>${esc(e.at.replace("T", " ").slice(0, 19))}</td><td>${esc(e.operator)}</td><td>${esc(e.action)}</td><td>${esc(e.target)}</td><td>${esc(e.outcome)}${e.detail ? ` <span class="muted">(${esc(e.detail)})</span>` : ""}</td></tr>`
    )
    .join("");
  return page({
    title: "Audit log | Relay Console",
    session,
    body: `<div class="card">
  <h1>Audit log</h1>
  <p class="muted">${session.role === "engineer" ? "Every operator's" : "Your"} most recent ${entries.length} event${entries.length === 1 ? "" : "s"}, newest first. Times are UTC. Kept for 90 days.</p>
  <div style="overflow-x:auto"><table>
    <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Outcome</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="5">Nothing recorded yet.</td></tr>`}</tbody>
  </table></div>
</div>`,
  });
}
