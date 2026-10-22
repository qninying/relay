// STORY-101: the console's shared page shell, reused by every later console
// screen. Server-rendered HTML, design tokens for light and dark mode, works
// at phone width, no external assets (the CSP allows only 'self'). All
// dynamic text goes through esc().

import type { Session } from "./auth/sessions.js";
import { newIdempotencyKey } from "./actions.js";

export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const STYLE = `
  :root { --bg:#f6f6f3; --surface:#ffffff; --text:#1c1c1a; --muted:#5d5d58; --border:#e2e2dc; --accent:#1f5f8b; --accent-text:#ffffff; --danger:#b3261e; --ok:#1f7a4d; --focus:#1f5f8b; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141413; --surface:#1e1e1c; --text:#ececea; --muted:#a6a6a0; --border:#34342f; --accent:#7cb7e0; --accent-text:#0d1b26; --danger:#ff8a80; --ok:#6cc893; --focus:#7cb7e0; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 16px; background:var(--surface); border-bottom:1px solid var(--border); flex-wrap:wrap; }
  header .brand { font-weight:700; }
  header .who { color:var(--muted); font-size:14px; display:flex; align-items:center; gap:12px; }
  main { max-width:960px; margin:0 auto; padding:24px 16px 48px; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:24px; }
  .narrow { max-width:400px; margin:48px auto 0; }
  h1 { font-size:22px; margin:0 0 16px; }
  label { display:block; font-weight:600; font-size:14px; margin:16px 0 6px; }
  input { width:100%; font:inherit; padding:10px 12px; border:1px solid var(--border); border-radius:8px; background:var(--bg); color:var(--text); }
  button { font:inherit; font-weight:600; padding:10px 16px; border-radius:8px; border:1px solid transparent; background:var(--accent); color:var(--accent-text); cursor:pointer; }
  button.link { background:none; color:var(--accent); padding:0; border:0; font-weight:500; text-decoration:underline; }
  .full { width:100%; margin-top:20px; }
  :focus-visible { outline:3px solid var(--focus); outline-offset:2px; }
  .error { color:var(--danger); background:color-mix(in srgb, var(--danger) 10%, transparent); border-radius:8px; padding:10px 12px; margin:0 0 8px; }
  .muted { color:var(--muted); }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--border); vertical-align:top; }
  th { color:var(--muted); font-weight:600; }
  form.inline { display:inline; margin:0; }
`;

export interface PageOptions {
  title: string;
  body: string;
  session?: Session | null;
}

export function page({ title, body, session }: PageOptions): string {
  const who = session
    ? `<div class="who"><span>Signed in as <strong>${esc(session.username)}</strong> (${esc(session.role)})</span>
       <form class="inline" method="post" action="/console/logout"><input type="hidden" name="csrf" value="${esc(session.csrfToken)}"><button class="link" type="submit">Sign out</button></form></div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header><span class="brand">Relay Console</span>${who}</header>
<main>
${body}
</main>
</body>
</html>
`;
}

// Hidden fields every action form needs (STORY-102): the session's CSRF
// token and a fresh one-time idempotency key for this rendering of the form.
export function actionFields(session: Session): string {
  return `<input type="hidden" name="csrf" value="${esc(session.csrfToken)}"><input type="hidden" name="idem" value="${newIdempotencyKey()}">`;
}
