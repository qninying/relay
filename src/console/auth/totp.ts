// STORY-101 (REQ-101): TOTP (RFC 6238 over RFC 4226 HOTP), ported from
// CoreOps (ai-operations-center/mcp-server/src/auth/totp.ts), node:crypto
// only. One change: replay protection is not kept in memory here. The
// matching step is returned, and the operator store (operators.ts) records
// it atomically in Redis, so a code can't be reused across requests,
// restarts or deploys.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error("Invalid base32 character in TOTP secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function totpCodeForStep(secretBase32: string, step: number, digits = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step >>> 0, 4);
  const hmac = createHmac("sha1", base32Decode(secretBase32)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const truncated =
    ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return (truncated % 10 ** digits).toString().padStart(digits, "0");
}

export function stepAt(timeMs: number): number {
  return Math.floor(timeMs / 1000 / TOTP_STEP_SECONDS);
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}

// Returns the step the code matched, or null. Accepts exactly one step of
// clock drift either side (a phone a little fast or slow), never more, and
// never a step at or before lastAcceptedStep (no replay).
export function matchTotp(secretBase32: string, code: string, nowMs: number, lastAcceptedStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = stepAt(nowMs);
  let matched: number | null = null;
  // Check every candidate rather than returning early, so timing doesn't
  // reveal which drift step matched.
  for (const step of [current - 1, current, current + 1]) {
    if (lastAcceptedStep !== null && step <= lastAcceptedStep) continue;
    if (constantTimeEqual(totpCodeForStep(secretBase32, step), code) && matched === null) matched = step;
  }
  return matched;
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20)); // 160 bits, RFC 6238's recommended size
}

// For manual entry in any authenticator app (or tapping on a phone).
export function otpAuthUri(secretBase32: string, account: string, issuer = "Relay"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams([
    ["secret", secretBase32],
    ["issuer", issuer],
    ["algorithm", "SHA1"],
    ["digits", "6"],
    ["period", "30"],
  ]);
  return `otpauth://totp/${label}?${params.toString()}`;
}
