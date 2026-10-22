// STORY-105: batch counts shared by every tab polling the same batch.
//
// Counting a batch reads every item result (HSCAN), so 50 open tabs polling
// a 5,000-item batch every 5 seconds would be 50 full scans per 5 seconds.
// Here a batch is counted at most once per ttlMs per process, and callers
// that arrive while a count is running wait for that same count. A failed
// count is not kept, so the next poll tries again. Bounded to maxEntries
// batches (oldest dropped first).

export class ProgressCache<T> {
  private readonly entries = new Map<string, { at: number; value: Promise<T> }>();

  constructor(
    private readonly load: (key: string) => Promise<T>,
    private readonly ttlMs = 2000,
    private readonly maxEntries = 500,
    private readonly now: () => number = Date.now
  ) {}

  get(key: string): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const entry = { at: this.now(), value: this.load(key) };
    this.entries.delete(key);
    this.entries.set(key, entry);
    // Only drops this entry; the caller still receives the rejection.
    entry.value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    return entry.value;
  }
}
