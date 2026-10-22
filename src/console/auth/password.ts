// STORY-101: password hashing with scrypt (node:crypto), same scheme as
// CoreOps's credentials.ts ("<saltHex>:<hashHex>"). Async here, unlike
// CoreOps: scryptSync would block the event loop that also serves the status
// page and supervises workers.

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;

function derive(pw: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(pw, salt, KEY_LENGTH, (error, key) => (error ? reject(error) : resolve(key))));
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${(await derive(pw, salt)).toString("hex")}`;
}

// false for a wrong password and for a malformed stored hash: rejecting is
// the safe default for bad data, never throwing out of the login route.
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex, extra] = stored.split(":");
  if (!saltHex || !hashHex || extra !== undefined) return false;
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await derive(pw, Buffer.from(saltHex, "hex"));
  return timingSafeEqual(actual, expected);
}

// Verified against when the username doesn't exist, so an unknown user takes
// as long to reject as a wrong password (no account enumeration by timing).
export const DUMMY_HASH = `${"00".repeat(16)}:${"00".repeat(KEY_LENGTH)}`;
