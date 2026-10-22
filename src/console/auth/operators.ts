// STORY-101: named console operators (REQ-101), stored in Redis so accounts
// survive restarts and deploys. Accounts are managed with one command each
// over `fly ssh console` (src/console/manageOperators.ts); there is no
// sign-up page.
//
// One hash per operator: role, scrypt password hash, TOTP secret, disabled
// flag, and the last accepted TOTP step (replay protection). The step is
// recorded with a Lua compare-and-set, so two simultaneous logins with the
// same code can't both succeed.

import type { Redis } from "ioredis";

export type Role = "analyst" | "engineer";

export interface Operator {
  username: string;
  role: Role;
  passwordHash: string;
  totpKey: string;
  disabled: boolean;
  lastTotpStep: number | null;
}

export const USERNAME_PATTERN = /^[a-z][a-z0-9._-]{1,31}$/;

// Sets last_totp_step only if the new step is strictly greater. Returns 1 if
// recorded, 0 if this step (or a later one) was already used.
const ACCEPT_STEP = `
local current = redis.call('HGET', KEYS[1], 'last_totp_step')
if current and tonumber(current) >= tonumber(ARGV[1]) then return 0 end
redis.call('HSET', KEYS[1], 'last_totp_step', ARGV[1])
return 1
`;

export class OperatorStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "relay:console:operator:"
  ) {}

  private key(username: string): string {
    return this.prefix + username;
  }

  async get(username: string): Promise<Operator | null> {
    if (!USERNAME_PATTERN.test(username)) return null;
    const h = await this.redis.hgetall(this.key(username));
    if (!h.username) return null;
    return {
      username: h.username,
      role: h.role === "engineer" ? "engineer" : "analyst",
      passwordHash: h.password_hash ?? "",
      totpKey: h.totp_secret ?? "",
      disabled: h.disabled === "1",
      lastTotpStep: h.last_totp_step ? Number(h.last_totp_step) : null,
    };
  }

  // Refuses to overwrite an existing operator (HSETNX on username first), so
  // re-running a create command can't silently reset someone's credentials.
  async create(op: Omit<Operator, "disabled" | "lastTotpStep">): Promise<boolean> {
    if (!USERNAME_PATTERN.test(op.username)) throw new Error("username must be 2-32 chars: lowercase letters, digits, . _ -");
    const key = this.key(op.username);
    const created = await this.redis.hsetnx(key, "username", op.username);
    if (!created) return false;
    await this.redis.hset(key, "role", op.role, "password_hash", op.passwordHash, "totp_secret", op.totpKey, "disabled", "0");
    return true;
  }

  async setDisabled(username: string, disabled: boolean): Promise<boolean> {
    if (!(await this.get(username))) return false;
    await this.redis.hset(this.key(username), "disabled", disabled ? "1" : "0");
    return true;
  }

  async resetMfa(username: string, totpKey: string): Promise<boolean> {
    if (!(await this.get(username))) return false;
    await this.redis.hset(this.key(username), "totp_secret", totpKey);
    await this.redis.hdel(this.key(username), "last_totp_step");
    return true;
  }

  async setPasswordHash(username: string, passwordHash: string): Promise<boolean> {
    if (!(await this.get(username))) return false;
    await this.redis.hset(this.key(username), "password_hash", passwordHash);
    return true;
  }

  async acceptTotpStep(username: string, step: number): Promise<boolean> {
    return (await this.redis.eval(ACCEPT_STEP, 1, this.key(username), String(step))) === 1;
  }

  async list(): Promise<Array<Pick<Operator, "username" | "role" | "disabled">>> {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await this.redis.scan(cursor, "MATCH", `${this.prefix}*`, "COUNT", 100);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");
    const ops = await Promise.all(keys.map((k) => this.get(k.slice(this.prefix.length))));
    return ops.filter((o): o is Operator => o !== null).map(({ username, role, disabled }) => ({ username, role, disabled }));
  }
}
