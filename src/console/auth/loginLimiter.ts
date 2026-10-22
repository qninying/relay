// STORY-101 (REQ-102): failed-login limiting, per account and per client IP,
// in Redis so it holds across restarts. After maxFailures failures within
// the window, every attempt for that account or IP is refused until the
// window (counted from the first failure) passes, even with the right
// password and code. Only failures count; a success does not reset the IP
// counter, so one valid account can't be used to keep guessing others.

import type { Redis } from "ioredis";

export interface LimiterOptions {
  maxFailures?: number;
  windowSeconds?: number;
  prefix?: string;
}

export class LoginLimiter {
  private readonly maxFailures: number;
  private readonly windowSeconds: number;
  private readonly prefix: string;

  constructor(
    private readonly redis: Redis,
    options: LimiterOptions = {}
  ) {
    this.maxFailures = options.maxFailures ?? 5;
    this.windowSeconds = options.windowSeconds ?? 15 * 60;
    this.prefix = options.prefix ?? "relay:console:loginfail:";
  }

  private keys(username: string, ip: string): string[] {
    return [`${this.prefix}user:${username.toLowerCase()}`, `${this.prefix}ip:${ip}`];
  }

  // Seconds until allowed again, or 0 if allowed now.
  async blockedFor(username: string, ip: string): Promise<number> {
    const keys = this.keys(username, ip);
    const counts = await this.redis.mget(...keys);
    let wait = 0;
    for (let i = 0; i < keys.length; i++) {
      if (Number(counts[i] ?? 0) >= this.maxFailures) wait = Math.max(wait, await this.redis.ttl(keys[i]));
    }
    return Math.max(0, wait);
  }

  async recordFailure(username: string, ip: string): Promise<void> {
    const multi = this.redis.multi();
    for (const key of this.keys(username, ip)) {
      multi.incr(key);
      // NX: the window starts at the first failure and is not extended.
      multi.expire(key, this.windowSeconds, "NX");
    }
    await multi.exec();
  }

  async clearAccount(username: string): Promise<void> {
    await this.redis.del(this.keys(username, "")[0]);
  }
}
