// Relay Command Center — shared runtime.
// Fetches .colaberry/*.json at runtime (never hard-coded into a page), renders
// the shared nav + "Data as of" header, and manages the global sample/real toggle.
// Every page includes this file and calls CommandCenter.init(tabId, render).

const TABS = [
  { id: "overview", label: "Overview", href: "index.html" },
  { id: "outcomes", label: "Outcomes", href: "outcomes.html" },
  { id: "users", label: "Users & Use Case", href: "users.html" },
  { id: "guardrails", label: "Guardrails", href: "guardrails.html" },
  { id: "systems", label: "Systems", href: "systems.html" },
  { id: "project-management", label: "Project Management", href: "project-management.html" },
  { id: "agents", label: "AI Agents", href: "agents.html" },
  { id: "knowledge-base", label: "Knowledge Base", href: "knowledge-base.html" },
  { id: "data-model", label: "Data Model", href: "data-model.html" },
];

const MODE_KEY = "cc-mode"; // "sample" | "real"

function getMode() {
  return localStorage.getItem(MODE_KEY) || "sample";
}

function setMode(mode) {
  localStorage.setItem(MODE_KEY, mode);
  location.reload();
}

async function fetchJson(path) {
  // no-store: these files change every time the platform syncs, and the whole
  // point of manifest.json's staleness check is detecting exactly that change.
  // A cached response would make the freshness indicator itself go stale.
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function loadData() {
  const [plan, progress, manifest] = await Promise.all([
    fetchJson(".colaberry/plan.json").catch(() => null),
    fetchJson(".colaberry/progress.json").catch(() => null),
    fetchJson(".colaberry/manifest.json").catch(() => null),
  ]);
  return { plan, progress, manifest };
}

function formatDataAsOf(manifest) {
  if (!manifest || !manifest.generated_at) {
    return { text: "Data as of: unknown — .colaberry/manifest.json is missing or unreadable", stale: true };
  }
  const generated = new Date(manifest.generated_at);
  const now = new Date();
  const diffDays = (now - generated) / (1000 * 60 * 60 * 24);
  // timeZone: "UTC" for the same reason as formatDateOrUnset below: this page is
  // public and viewed from any timezone, so the displayed date should be the one
  // instant everyone agrees on, not shifted by whichever visitor's local clock
  // happens to render it.
  const absolute = generated.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  let relative;
  if (diffDays < 1) relative = "today";
  else if (diffDays < 2) relative = "1 day ago";
  else relative = `${Math.floor(diffDays)} days ago`;
  const stale = diffDays > 7;
  let text = `Data as of ${absolute} (${relative})`;
  if (stale) text += " — sync from the portal to refresh";
  return { text, stale };
}

function sampleBadge() {
  return getMode() === "sample" ? '<span class="cc-sample-badge">Sample data</span>' : "";
}

// Drill-down param, e.g. outcomes.html?id=REQ-017 — every tab handles both a
// list view (no id) and a detail view (id present) in the same file.
function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

// Named escapeHtml internally (not "esc") specifically so every page's inline
// script can safely do `const { esc } = CommandCenter;` without colliding with
// a same-named top-level function declaration — these are plain <script> tags
// sharing one global scope, not modules, so that redeclaration is a SyntaxError
// that silently aborts the whole script.
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

// A date field can be null this early in the build (plan.schedule and
// releases[].starts_on/ends_on all start unset) — render "not scheduled yet"
// rather than "Invalid Date", which is what `new Date(null)` silently produces.
//
// timeZone: "UTC" is load-bearing, not decoration: a date-only ISO string like
// "2026-09-24" parses as UTC midnight, and formatting that in a negative-offset
// local zone (e.g. America/Chicago) silently prints the day before — a real,
// confirmed bug caught in review (STORY-001's due_on rendered as "Sep 23" for
// a date that is actually "2026-09-24"). Formatting in UTC keeps the displayed
// date matching the plan's own date string, regardless of the viewer's clock.
function formatDateOrUnset(value) {
  if (!value) return "not scheduled yet";
  return new Date(value).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// Finds every story that fulfils a requirement, then looks up each story's
// verification state in progress.json. A requirement/guardrail counts as
// "enforced" only if EVERY fulfilling story is verified — partial coverage is
// shown as partial, not rounded up to enforced.
function verificationForRequirement(plan, progress, req) {
  const storyIds = (req && req.fulfilled_by) || [];
  if (storyIds.length === 0) {
    return { state: "unfulfilled", stories: [] };
  }
  const progressStories = (progress && progress.stories) || [];
  const stories = storyIds.map((id) => {
    const planStory = (plan.stories || []).find((s) => s.id === id);
    const progressStory = progressStories.find((s) => s.id === id);
    const state = progressStory && progressStory.verification ? progressStory.verification.state : "not_started";
    return { id, title: planStory ? planStory.title : id, state };
  });
  const allVerified = stories.every((s) => s.state === "verified");
  const anyVerified = stories.some((s) => s.state === "verified");
  const state = allVerified ? "enforced" : anyVerified ? "partial" : "not_enforced";
  return { state, stories };
}

function statusDot(state) {
  const cls = state === "verified" || state === "enforced" ? "cc-dot-ok"
    : state === "error" ? "cc-dot-error" : "";
  return `<span class="cc-dot ${cls}"></span>`;
}

// "Not built yet" placeholder for the 8 tabs not built in this pass — reachable,
// not locked or greyed, per the brief: the build is waiting on the student, not
// the other way round.
function notBuiltYet(tabLabel) {
  return `<div class="cc-empty-state">
    <p style="margin:0 0 8px; font-weight:600;">${escapeHtml(tabLabel)} — not built yet</p>
    <p style="margin:0;">Say <strong>build the rest</strong> when the Overview tab looks right, and this tab gets built next.</p>
  </div>`;
}

function renderChrome(activeTabId, dataAsOf) {
  const nav = document.getElementById("cc-nav");
  const modeToggle = document.getElementById("cc-mode-toggle");
  const stamp = document.getElementById("cc-data-as-of");

  if (nav) {
    nav.innerHTML = TABS.map(
      (t) => `<a href="${t.href}" class="cc-tab${t.id === activeTabId ? " active" : ""}">${t.label}</a>`
    ).join("");
  }

  if (modeToggle) {
    const mode = getMode();
    modeToggle.innerHTML = `
      <button class="cc-mode-btn${mode === "sample" ? " active" : ""}" data-mode="sample">Sample</button>
      <button class="cc-mode-btn${mode === "real" ? " active" : ""}" data-mode="real">Real</button>
    `;
    modeToggle.querySelectorAll(".cc-mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => setMode(btn.dataset.mode));
    });
  }

  if (stamp && dataAsOf) {
    stamp.textContent = dataAsOf.text;
    stamp.className = "cc-data-as-of" + (dataAsOf.stale ? " cc-stale" : "");
  }
}

// init(tabId, renderFn): fetches data, renders shared chrome, then calls
// renderFn({ plan, progress, manifest, mode }) to render the page's own content.
async function init(tabId, renderFn) {
  const { plan, progress, manifest } = await loadData();
  const dataAsOf = formatDataAsOf(manifest);
  renderChrome(tabId, dataAsOf);
  if (renderFn) {
    renderFn({ plan, progress, manifest, mode: getMode(), dataAsOf });
  }
}

window.CommandCenter = {
  TABS, getMode, setMode, loadData, formatDataAsOf, renderChrome, sampleBadge,
  init, getParam, esc: escapeHtml, verificationForRequirement, statusDot,
  notBuiltYet, formatDateOrUnset,
};
