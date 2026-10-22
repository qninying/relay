// How long a submitted batch (its record, inputs and results) is kept
// before Redis deletes it. Without a limit, batches pile up until Redis is
// full, and Redis here refuses writes when full (noeviction), which would
// stop all of Relay, not just the console.
//
// The policy is 30 days: long enough to hand results on and answer
// questions about them. RELAY_BATCH_RETENTION_DAYS overrides it; the
// portfolio deployment on Fly sets 5 to stay small on its 256 MB Redis.
// A bad value stops the server at boot instead of being guessed at.

export const DEFAULT_BATCH_RETENTION_DAYS = 30;
export const DAY_MS = 24 * 60 * 60 * 1000;

export class RetentionConfigError extends Error {}

export function batchRetentionDaysFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RELAY_BATCH_RETENTION_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_BATCH_RETENTION_DAYS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new RetentionConfigError(`RELAY_BATCH_RETENTION_DAYS must be a whole number of days from 1 to 365, got ${JSON.stringify(raw)}`);
  return days;
}
