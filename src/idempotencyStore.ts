// Enforces REQ-002: a re-delivered job (same idempotency key) must not
// double-process. In-memory for STORY-001's walking skeleton — swappable for a
// Redis/SQS-backed store behind the same interface once STORY-002 adds the real
// queue, without changing processJob's logic.

export interface IdempotencyStore {
  // Atomic check-and-set: returns true the FIRST time a key is seen, false on
  // every call after. A separate has()-then-set() pair would race under
  // concurrent delivery of the same re-delivered job; this doesn't.
  claim(idempotencyKey: string): boolean;
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
