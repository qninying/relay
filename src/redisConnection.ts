// STORY-010: one place that builds the Redis client from the environment,
// shared by the production server and every worker process it forks.
//
// REDIS_URL carries host, port and password (redis://:<password>@host:port);
// it is a secret in production (`fly secrets set`), never committed.
// REDIS_FAMILY=6 is needed on Fly.io, whose private network (*.internal) is
// IPv6-only; ioredis defaults to IPv4 and would never connect.
//
// Every command has an explicit timeout and capped retries (CLAUDE.md: no
// unbounded waits). Reconnects back off up to 2s and never stop: a Redis
// restart should be survived, and every caller already handles a failing
// command (logged, retried by its own loop).

import { Redis } from "ioredis";

export function redisFromEnv(env: NodeJS.ProcessEnv = process.env): Redis {
  const url = env.REDIS_URL ?? "redis://localhost:6379";
  const family = env.REDIS_FAMILY === "6" ? 6 : 4;
  const redis = new Redis(url, {
    family,
    connectTimeout: 5000,
    commandTimeout: 5000,
    maxRetriesPerRequest: 2,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
  });
  // Without a listener ioredis prints unstructured errors on every reconnect
  // attempt. Failures still surface where it matters: the commands reject.
  redis.on("error", () => {});
  return redis;
}

// For logs: never print the password.
export function redactRedisUrl(url: string | undefined): string {
  if (!url) return "redis://localhost:6379";
  return url.replace(/\/\/([^@/]*)@/, "//<redacted>@");
}
