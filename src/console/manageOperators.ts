// STORY-101: manage console operator accounts. There is no sign-up page;
// accounts are created by whoever can reach the deployment:
//
//   fly ssh console -a relay-qn -C "node dist/src/console/manageOperators.js create quincy engineer"
//   (locally: npx tsx console/manageOperators.ts create quincy engineer)
//
// Commands: create <username> <analyst|engineer>, list, disable <username>,
// enable <username>, reset-password <username>, reset-mfa <username>,
// unlock <username>.
//
// Passwords and authenticator secrets are generated here (strong, random)
// and printed ONCE to this terminal for the new operator to store in a
// password manager and authenticator app. They are never logged, never
// stored in plain form, and never passed on the command line, so they can't
// end up in shell history.

import { randomBytes } from "node:crypto";
import { redisFromEnv } from "../redisConnection.js";
import { OperatorStore, USERNAME_PATTERN, type Role } from "./auth/operators.js";
import { hashPassword } from "./auth/password.js";
import { generateTotpSecret, otpAuthUri } from "./auth/totp.js";
import { LoginLimiter } from "./auth/loginLimiter.js";
import { logJson } from "../logger.js";

const out = (line = "") => process.stderr.write(`${line}\n`);

function newPassword(): string {
  return randomBytes(18).toString("base64url"); // 24 chars, ~144 bits
}

function showSecret(username: string, pw: string | null, totpKey: string | null): void {
  out();
  out("  Shown once. Save these now; they can't be shown again (only reset).");
  out(`  Username: ${username}`);
  if (pw) out(`  Password: ${pw}`);
  if (totpKey) {
    out(`  Authenticator setup key: ${totpKey.replace(/(.{4})/g, "$1 ").trim()}`);
    out("    In your authenticator app: add account > enter a setup key > time-based.");
    out(`    Or open this link on the phone: ${otpAuthUri(totpKey, username)}`);
  }
  out();
}

async function main(): Promise<number> {
  const [command, username, roleArg] = process.argv.slice(2);
  const redis = redisFromEnv();
  const operators = new OperatorStore(redis);
  try {
    if (command === "list") {
      for (const op of await operators.list()) out(`${op.username.padEnd(24)} ${op.role.padEnd(9)} ${op.disabled ? "disabled" : "active"}`);
      return 0;
    }
    if (!command || !username || !USERNAME_PATTERN.test(username)) {
      out("usage: manageOperators <create|disable|enable|reset-password|reset-mfa|unlock> <username> [analyst|engineer] | list");
      out("username: 2-32 chars, lowercase letters, digits, . _ -");
      return 2;
    }
    const audit = (action: string) =>
      logJson("info", { event: "console_operator_admin", correlationId: randomBytes(8).toString("hex"), outcome: "success", context: { action, username } });

    switch (command) {
      case "create": {
        if (roleArg !== "analyst" && roleArg !== "engineer") {
          out("role must be analyst or engineer");
          return 2;
        }
        const pw = newPassword();
        const totpKey = generateTotpSecret();
        const created = await operators.create({ username, role: roleArg as Role, passwordHash: await hashPassword(pw), totpKey });
        if (!created) {
          out(`${username} already exists; nothing changed. Use reset-password or reset-mfa.`);
          return 1;
        }
        audit("create");
        showSecret(username, pw, totpKey);
        return 0;
      }
      case "disable":
      case "enable": {
        if (!(await operators.setDisabled(username, command === "disable"))) return notFound(username);
        audit(command);
        out(`${username} ${command}d.`);
        return 0;
      }
      case "reset-password": {
        const pw = newPassword();
        if (!(await operators.setPasswordHash(username, await hashPassword(pw)))) return notFound(username);
        audit("reset-password");
        showSecret(username, pw, null);
        return 0;
      }
      case "reset-mfa": {
        const totpKey = generateTotpSecret();
        if (!(await operators.resetMfa(username, totpKey))) return notFound(username);
        audit("reset-mfa");
        showSecret(username, null, totpKey);
        return 0;
      }
      case "unlock": {
        await new LoginLimiter(redis).clearAccount(username);
        audit("unlock");
        out(`${username}'s failed-login counter cleared (per-IP limits still apply).`);
        return 0;
      }
      default:
        out(`unknown command: ${command}`);
        return 2;
    }
  } finally {
    redis.disconnect();
  }
}

function notFound(username: string): number {
  out(`no operator named ${username}`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    out(`manageOperators failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
);
