// STORY-108 (REQ-112): an accessibility and layout audit run in real
// headless Chrome, driven over the Chrome DevTools Protocol with Node's
// built-in WebSocket (no new dependency). Test support only.
//
// Per page, at a given width and colour scheme, it checks what the
// rendered page actually does:
// - no horizontal scroll (page wider than the viewport);
// - WCAG 2.1 AA text contrast (1.4.3): every visible text node, HTML and
//   SVG, against its effective background (layers composited up to the
//   first opaque one), 4.5:1, or 3:1 for large text;
// - non-text contrast (1.4.11): form-field borders and chart lines, 3:1;
// - every form field has a label, the page has a title, lang, one h1 and
//   a main landmark, no positive tabindex, and charts have a text name;
// - keyboard (2.1.1, 2.4.7): pressing Tab reaches every visible control,
//   and each one shows a focus outline of at least 2px.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class Browser {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, Pending>();
  private listeners: Array<(method: string, params: any) => void> = [];

  private constructor(
    private readonly proc: ChildProcess,
    private readonly dir: string
  ) {}

  static async launch(): Promise<Browser> {
    const dir = mkdtempSync(join(tmpdir(), "relay-a11y-"));
    const proc = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    const port = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const t = setTimeout(() => reject(new Error("Chrome did not start within 15s")), 15_000);
      proc.stderr!.on("data", (d: Buffer) => {
        buf += d.toString();
        const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
        if (m) {
          clearTimeout(t);
          resolve(m[1]);
        }
      });
      proc.on("exit", (code) => reject(new Error(`Chrome exited early (${code})`)));
    });
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const b = new Browser(proc, dir);
    b.ws = new WebSocket(targets.find((t) => t.type === "page")!.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      b.ws.onopen = () => resolve();
      b.ws.onerror = () => reject(new Error("CDP connection failed"));
    });
    b.ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.id !== undefined) {
        const p = b.pending.get(msg.id);
        b.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(`${msg.error.message}`));
        else p?.resolve(msg.result);
      } else for (const l of b.listeners) l(msg.method, msg.params);
    };
    await b.send("Page.enable");
    await b.send("Network.enable");
    // Headless pages aren't focused by default; :focus-visible needs focus.
    await b.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    return b;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  waitFor(event: string, timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
      const l = (method: string) => {
        if (method === event) {
          clearTimeout(t);
          this.listeners = this.listeners.filter((x) => x !== l);
          resolve();
        }
      };
      this.listeners.push(l);
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }

  async goto(url: string): Promise<void> {
    const loaded = this.waitFor("Page.loadEventFired");
    await this.send("Page.navigate", { url });
    await loaded;
  }

  // Runs `script` (which navigates, e.g. submits a form) and waits for the next page.
  async navigateBy(script: string): Promise<void> {
    const loaded = this.waitFor("Page.loadEventFired");
    await this.evaluate(script);
    await loaded;
  }

  async viewport(width: number, scheme: "light" | "dark"): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 2, mobile: true });
    await this.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  }

  async setCookie(name: string, value: string, url: string): Promise<void> {
    await this.send("Network.setCookie", { name, value, url, path: "/console" });
  }

  async close(): Promise<void> {
    this.ws.close();
    this.proc.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 100));
    rmSync(this.dir, { recursive: true, force: true });
  }
}

// Static checks, run inside the page. Returns a list of problems.
const STATIC_AUDIT = `(() => {
  const issues = [];
  const toRgba = (c) => {
    let m = c.match(/^rgba?\\(([^)]+)\\)/);
    if (m) { const p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    m = c.match(/^color\\(srgb ([^)]+)\\)/);
    if (m) { const p = m[1].split(/[\\s\\/]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 }; }
    return null;
  };
  const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  const bgOf = (el) => {
    const layers = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const c = toRgba(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return base;
  };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const visible = (el) => { const s = getComputedStyle(el); return s.visibility !== "hidden" && s.display !== "none" && el.getClientRects().length > 0; };
  const name = (el) => el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.split(" ").join(".") : "") + ' "' + (el.textContent || "").trim().slice(0, 30) + '"';

  if (document.documentElement.scrollWidth > window.innerWidth + 1) issues.push("horizontal scroll: page is " + document.documentElement.scrollWidth + "px wide at " + window.innerWidth + "px");
  if (!document.documentElement.lang) issues.push("no lang on <html>");
  if (!document.title.trim()) issues.push("empty <title>");
  if (document.querySelectorAll("h1").length !== 1) issues.push("expected one h1, found " + document.querySelectorAll("h1").length);
  if (!document.querySelector("main")) issues.push("no <main> landmark");
  for (const el of document.querySelectorAll("[tabindex]")) if (Number(el.getAttribute("tabindex")) > 0) issues.push("positive tabindex on " + name(el));

  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || !n.textContent.trim() || seen.has(el) || !visible(el)) continue;
    if (el.closest("title, desc, script, style")) continue;
    seen.add(el);
    const s = getComputedStyle(el);
    const svgText = el instanceof SVGElement;
    const fg = toRgba(svgText ? s.fill : s.color);
    if (!fg) { issues.push("unreadable colour on " + name(el)); continue; }
    const bg = bgOf(svgText ? el.closest("svg").parentElement : el);
    const size = parseFloat(s.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
    const r = ratio(over(fg, bg), bg);
    if (r < (large ? 3 : 4.5)) issues.push("text contrast " + r.toFixed(2) + ":1 (needs " + (large ? 3 : 4.5) + ") on " + name(el));
  }
  for (const el of document.querySelectorAll("input:not([type=hidden]), select, textarea")) {
    if (!visible(el)) continue;
    if (!(el.labels && el.labels.length) && !el.getAttribute("aria-label")) issues.push("no label for " + name(el));
    const border = toRgba(getComputedStyle(el).borderTopColor);
    const r = ratio(border, bgOf(el.parentElement));
    if (r < 3) issues.push("field border contrast " + r.toFixed(2) + ":1 (needs 3) on " + el.tagName.toLowerCase() + "#" + el.id);
  }
  for (const el of document.querySelectorAll("svg .line")) {
    const r = ratio(toRgba(getComputedStyle(el).stroke), bgOf(el.closest("svg").parentElement));
    if (r < 3) issues.push("chart line contrast " + r.toFixed(2) + ":1 (needs 3)");
  }
  for (const svg of document.querySelectorAll('svg[role="img"]')) {
    const ids = (svg.getAttribute("aria-labelledby") || "").split(" ").filter(Boolean);
    if (!ids.length || ids.some((id) => !document.getElementById(id) || !document.getElementById(id).textContent.trim())) issues.push("chart without a text name");
  }
  return issues;
})()`;

const MARK_FOCUSABLE = `(() => {
  const list = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex]')]
    .filter((el) => { const s = getComputedStyle(el); return s.visibility !== "hidden" && s.display !== "none" && el.getClientRects().length > 0 && !el.disabled && el.getAttribute("tabindex") !== "-1"; });
  list.forEach((el, i) => el.setAttribute("data-a11y", String(i)));
  return list.length;
})()`;

const FOCUSED = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const s = getComputedStyle(el);
  return { i: el.getAttribute("data-a11y"), outline: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2, what: el.tagName.toLowerCase() + ' "' + (el.textContent || el.getAttribute("name") || "").trim().slice(0, 30) + '"' };
})()`;

export async function auditPage(b: Browser): Promise<string[]> {
  const issues = await b.evaluate<string[]>(STATIC_AUDIT);
  const total = await b.evaluate<number>(MARK_FOCUSABLE);
  const reached = new Set<string>();
  for (let i = 0; i < total + 3; i++) {
    await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    const f = await b.evaluate<{ i: string | null; outline: boolean; what: string } | null>(FOCUSED);
    if (!f || f.i === null) continue;
    if (!reached.has(f.i) && !f.outline) issues.push(`no visible focus outline on ${f.what}`);
    reached.add(f.i);
  }
  if (reached.size < total) issues.push(`keyboard: Tab reached ${reached.size} of ${total} controls`);
  return issues;
}
