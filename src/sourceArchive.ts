// STORY-012: where the exact source text behind a summary is kept, so the
// summary can be checked against it later (REQ-016's trust criterion).
// Content-addressed by SHA-256: the same source stored twice is one entry
// (SET NX), and fetching by hash then re-hashing proves the text is exactly
// what the summary was checked against.
//
// Kept for SOURCE_TTL_SECONDS (30 days) rather than forever: long enough to
// audit a batch, without Redis growing without bound. Longer retention is a
// storage decision for the production deploy (STORY-010).

import type { Redis } from "ioredis";
import { createHash } from "node:crypto";

export interface ArchivedSource {
  sourceId: string;
  sha256: string;
  text: string;
  archivedAt: string;
}

export interface SourceArchive {
  put(sourceId: string, text: string): Promise<ArchivedSource>;
  get(sha256: string): Promise<ArchivedSource | null>;
}

export const SOURCE_TTL_SECONDS = 30 * 24 * 60 * 60;

export function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export class RedisSourceArchive implements SourceArchive {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "relay:source:"
  ) {}

  async put(sourceId: string, text: string): Promise<ArchivedSource> {
    const entry: ArchivedSource = { sourceId, sha256: sha256Of(text), text, archivedAt: new Date().toISOString() };
    await this.redis.set(this.prefix + entry.sha256, JSON.stringify(entry), "EX", SOURCE_TTL_SECONDS, "NX");
    return entry;
  }

  async get(sha256: string): Promise<ArchivedSource | null> {
    const raw = await this.redis.get(this.prefix + sha256);
    if (raw === null) return null;
    const entry = JSON.parse(raw) as ArchivedSource;
    // Never trust the stored copy blindly: it must still hash to its key.
    return sha256Of(entry.text) === sha256 ? entry : null;
  }
}
