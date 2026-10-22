// The console's HTTP plumbing (split out of routes.ts): security headers,
// responses, cookies, the client's IP, form bodies and streamed downloads.

import type http from "node:http";
import { once } from "node:events";
import { logJson } from "../logger.js";

export const SESSION_COOKIE = "relay_session";
const MAX_BODY_BYTES = 8 * 1024;

// A file streamed to the browser (e.g. a results CSV). Download routes may
// answer with a page instead (not found, unavailable).
export interface Download {
  filename: string;
  type: string;
  chunks: AsyncIterable<string>;
}
export const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

export function html(res: http.ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...HEADERS, ...extra });
  res.end(body);
}

export function redirect(res: http.ServerResponse, location: string, extra: Record<string, string> = {}): void {
  res.writeHead(303, { Location: location, ...HEADERS, ...extra });
  res.end();
}

export function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", ...HEADERS });
  res.end(JSON.stringify(body));
}

// Writes chunks as they come, waiting when the client is slow. Once the
// headers are out a failure can't become an error page, so the connection
// is cut instead: the browser reports a failed download rather than saving
// a file that silently stops partway.
export async function stream(res: http.ServerResponse, download: Download, correlationId: string): Promise<void> {
  res.writeHead(200, { "Content-Type": download.type, "Content-Disposition": `attachment; filename="${download.filename}"`, ...HEADERS });
  try {
    for await (const chunk of download.chunks) {
      if (res.destroyed) return;
      if (!res.write(chunk)) await Promise.race([once(res, "drain"), once(res, "close")]);
    }
    res.end();
  } catch (error) {
    logJson("error", {
      event: "console_download_interrupted",
      correlationId,
      outcome: "failure",
      errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
      context: { filename: download.filename },
    });
    res.destroy();
  }
}

export function readCookie(req: http.IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || null;
  }
  return null;
}

export function sessionCookie(id: string, secure: boolean, maxAgeSeconds: number): string {
  return [`${SESSION_COOKIE}=${id}`, "Path=/console", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSeconds}`, ...(secure ? ["Secure"] : [])].join("; ");
}

export function clientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  const forwarded = req.headers["fly-client-ip"];
  if (trustProxy && typeof forwarded === "string" && forwarded) return forwarded;
  return req.socket.remoteAddress ?? "unknown";
}

// Bodies beyond this are cut off by closing the connection; anything up to
// it is read (and discarded once over maxBytes) so the client reliably gets
// the 4xx answer instead of a connection reset mid-upload.
const DRAIN_LIMIT_BYTES = 16 * 1024 * 1024;

export async function readForm(req: http.IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<URLSearchParams | null> {
  const type = req.headers["content-type"] ?? "";
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > DRAIN_LIMIT_BYTES) {
      req.destroy();
      return null;
    }
    if (size <= maxBytes) chunks.push(chunk as Buffer);
  }
  if (size > maxBytes || !type.startsWith("application/x-www-form-urlencoded")) return null;
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}
