// STORY-102 (REQ-103): the console's audit log. Append-only Redis stream,
// one entry per console event: sign-in attempts, sign-out, and every action
// (batch submit, review decision, resubmit, discard in later stories).
//
// Kept for 90 days (XADD MINID, exact, trims older entries as new ones arrive), so
// it can't grow without bound. Entries are never edited or deleted by the
// console. Writes throw on failure; callers decide what that means (an
// action is not performed if its audit entry can't be written).

import type { Redis } from "ioredis";

export type AuditOutcome = "performed" | "succeeded" | "failed" | "rejected" | "duplicate";

export interface AuditEntry {
  id?: string;
  at: string;
  operator: string;
  action: string;
  target: string;
  outcome: AuditOutcome;
  correlationId: string;
  detail?: string;
}

export const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export class AuditLog {
  constructor(
    private readonly redis: Redis,
    private readonly key = "relay:console:audit",
    private readonly now: () => number = Date.now
  ) {}

  async record(entry: Omit<AuditEntry, "at" | "id">): Promise<string> {
    const at = this.now();
    const minId = String(at - AUDIT_RETENTION_MS);
    const fields = ["at", new Date(at).toISOString(), "operator", entry.operator, "action", entry.action, "target", entry.target, "outcome", entry.outcome, "correlation_id", entry.correlationId];
    if (entry.detail) fields.push("detail", entry.detail.slice(0, 500));
    const id = await this.redis.xadd(this.key, "MINID", minId, "*", ...fields);
    if (!id) throw new Error("audit XADD returned no id");
    return id;
  }

  // Newest first. operator limits to one operator's entries.
  async recent(limit = 100, operator?: string): Promise<AuditEntry[]> {
    const out: AuditEntry[] = [];
    let end = "+";
    while (out.length < limit) {
      const batch = (await this.redis.xrevrange(this.key, end, "-", "COUNT", 200)) as [string, string[]][];
      if (batch.length === 0) break;
      for (const [id, fields] of batch) {
        const f = new Map<string, string>();
        for (let i = 0; i < fields.length; i += 2) f.set(fields[i], fields[i + 1]);
        const entry: AuditEntry = {
          id,
          at: f.get("at") ?? "",
          operator: f.get("operator") ?? "",
          action: f.get("action") ?? "",
          target: f.get("target") ?? "",
          outcome: (f.get("outcome") ?? "failed") as AuditOutcome,
          correlationId: f.get("correlation_id") ?? "",
          detail: f.get("detail"),
        };
        if (!operator || entry.operator === operator) out.push(entry);
        if (out.length >= limit) break;
      }
      const lastId = batch[batch.length - 1][0];
      const [ms, seq] = lastId.split("-").map(Number);
      end = seq > 0 ? `${ms}-${seq - 1}` : `${ms - 1}`;
      if (batch.length < 200) break;
    }
    return out;
  }
}
