// STORY-101 (REQ-101, REQ-102): server-side sessions in Redis. The cookie
// holds a random 256-bit id; Redis holds only its SHA-256, so a copy of the
// Redis data can't be replayed as a login. Sessions expire after 8 hours
// without activity (each authenticated request slides the expiry).
//
// Failure path: if Redis can't be reached, lookups throw. Callers treat that
// as "not logged in" for pages and as a 503 for login itself; nothing ever
// falls back to an unchecked session.

import type { Redis } from "ioredis";
import { createHash, randomBytes } from "node:crypto";
import type { Role } from "./operators.js";

export const SESSION_IDLE_SECONDS = 8 * 60 * 60;

export interface Session {
  username: string;
  role: Role;
  createdAt: string;
  // STORY-102 uses this for CSRF; created with the session.
  csrfToken: string;
}

function hashId(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

export class SessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "relay:console:session:",
    private readonly idleSeconds = SESSION_IDLE_SECONDS
  ) {}

  async create(username: string, role: Role): Promise<{ id: string; session: Session }> {
    const id = randomBytes(32).toString("base64url");
    const session: Session = { username, role, createdAt: new Date().toISOString(), csrfToken: randomBytes(32).toString("base64url") };
    await this.redis.set(this.prefix + hashId(id), JSON.stringify(session), "EX", this.idleSeconds);
    return { id, session };
  }

  // Returns the session and slides its expiry, or null if missing/expired.
  async touch(id: string): Promise<Session | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const key = this.prefix + hashId(id);
    const raw = await this.redis.getex(key, "EX", this.idleSeconds);
    return raw ? (JSON.parse(raw) as Session) : null;
  }

  async destroy(id: string): Promise<void> {
    await this.redis.del(this.prefix + hashId(id));
  }
}
