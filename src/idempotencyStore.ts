// Enforces REQ-002: a re-delivered job (same idempotency key) must not
// double-process. In-memory for STORY-001's walking skeleton — swappable for a
// Redis/SQS-backed store behind the same interface once STORY-002 adds the real
// queue, without changing processJob's logic.

import type { Redis } from "ioredis";

export interface IdempotencyStore {
  // Atomic check-and-set: returns true the FIRST time a key is seen, false on
  // every call after. A separate has()-then-set() pair would race under
  // concurrent delivery of the same re-delivered job; this doesn't.
  claim(idempotencyKey: string): boolean;
}

// STORY-009: the same atomic claim, shared by every worker process. With
// only a per-process store, a job redelivered to a different worker after a
// crash would be processed a second time.
export interface DurableIdempotencyStore {
  claim(idempotencyKey: string): Promise<boolean>;
}

// SET NX is the atomic check-and-set. Keys expire after ttlSeconds (7 days
// by default): long enough to cover any redelivery or DLQ resubmission
// window, without the key set growing forever.
export class RedisIdempotencyStore implements DurableIdempotencyStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "relay:idem:",
    private readonly ttlSeconds = 7 * 24 * 60 * 60
  ) {}

  async claim(idempotencyKey: string): Promise<boolean> {
    const result = await this.redis.set(this.prefix + idempotencyKey, "1", "EX", this.ttlSeconds, "NX");
    return result === "OK";
  }
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly seen = new Set<string>();

  claim(idempotencyKey: string): boolean {
    if (this.seen.has(idempotencyKey)) {
      return false;
    }
    this.seen.add(idempotencyKey);
    return true;
  }
}
