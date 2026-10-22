// STORY-101: auth primitives. TOTP is checked against RFC 6238 Appendix B's
// own SHA1 test vectors, not just against itself.

import { describe, it, expect } from "vitest";
import { base32Decode, base32Encode, generateTotpSecret, matchTotp, otpAuthUri, stepAt, totpCodeForStep } from "./totp.js";
import { DUMMY_HASH, hashPassword, verifyPassword } from "./password.js";

const RFC_KEY = base32Encode(Buffer.from("12345678901234567890", "ascii"));

describe("TOTP", () => {
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("RFC 6238 vector at T=%i is %s", (seconds, expected) => {
    expect(totpCodeForStep(RFC_KEY, stepAt(seconds * 1000), 8)).toBe(expected);
  });

  it("base32 round-trips and rejects invalid characters", () => {
    const key = generateTotpSecret();
    expect(base32Encode(base32Decode(key))).toBe(key);
    expect(base32Decode(key)).toHaveLength(20);
    expect(() => base32Decode("not!base32")).toThrow();
  });

  it("accepts exactly one step of clock drift either side, never two", () => {
    const key = generateTotpSecret();
    const now = 1_800_000_000_000;
    const step = stepAt(now);
    expect(matchTotp(key, totpCodeForStep(key, step), now, null)).toBe(step);
    expect(matchTotp(key, totpCodeForStep(key, step - 1), now, null)).toBe(step - 1);
    expect(matchTotp(key, totpCodeForStep(key, step + 1), now, null)).toBe(step + 1);
    expect(matchTotp(key, totpCodeForStep(key, step - 2), now, null)).toBeNull();
    expect(matchTotp(key, totpCodeForStep(key, step + 2), now, null)).toBeNull();
  });

  it("refuses a code at or before the last accepted step (no replay)", () => {
    const key = generateTotpSecret();
    const now = 1_800_000_000_000;
    const step = stepAt(now);
    expect(matchTotp(key, totpCodeForStep(key, step), now, step)).toBeNull();
    expect(matchTotp(key, totpCodeForStep(key, step - 1), now, step)).toBeNull();
    expect(matchTotp(key, totpCodeForStep(key, step + 1), now, step)).toBe(step + 1);
  });

  it("rejects anything that isn't exactly six digits", () => {
    const key = generateTotpSecret();
    for (const bad of ["", "12345", "1234567", "12345a", " 123456"]) expect(matchTotp(key, bad, Date.now(), null)).toBeNull();
  });

  it("builds an otpauth URI authenticator apps accept", () => {
    const sample = "JBSWY3DPEHPK3PXP"; // RFC-style example key, not a real account
    expect(otpAuthUri(sample, "quincy")).toBe(`otpauth://totp/Relay:quincy?secret=${sample}&issuer=Relay&algorithm=SHA1&digits=6&period=30`);
  });
});

describe("passwords", () => {
  it("hashes with a random salt and verifies only the right password", async () => {
    const a = await hashPassword("correct horse battery staple");
    const b = await hashPassword("correct horse battery staple");
    expect(a).not.toBe(b);
    expect(await verifyPassword("correct horse battery staple", a)).toBe(true);
    expect(await verifyPassword("Correct horse battery staple", a)).toBe(false);
  });

  it("rejects (never throws on) a malformed stored hash, and the dummy hash matches nothing", async () => {
    for (const bad of ["", "abc", "a:b:c", "zz:zz", `${"00".repeat(16)}:${"00".repeat(10)}`]) expect(await verifyPassword("x", bad)).toBe(false);
    expect(await verifyPassword("", DUMMY_HASH)).toBe(false);
    expect(await verifyPassword("anything", DUMMY_HASH)).toBe(false);
  });
});
