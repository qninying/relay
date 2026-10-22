#!/usr/bin/env bash
# STORY-010: one-time creation of Relay's two Fly.io apps. Safe to re-run:
# every step checks whether its resource already exists and skips it.
#
#   fly auth login            # once, opens a browser
#   ./scripts/setup-fly.sh    # creates apps, volume, secrets; deploys Redis
#   ./scripts/deploy.sh       # deploys the app (tests, smoke check, rollback)
#
# Creates billable resources (two machines, one 1GB volume; see
# docs/runbooks/DEPLOYMENT.md for costs). The Redis password is generated
# here and handed straight to `fly secrets set`; it is never printed,
# logged or written to disk.
set -euo pipefail

APP="${RELAY_APP:-relay-qn}"
REDIS_APP="${RELAY_REDIS_APP:-relay-qn-redis}"
REGION="${RELAY_REGION:-iad}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

step() { printf '\n==> %s\n' "$*"; }

fly auth whoami >/dev/null 2>&1 || { echo "Not logged in to Fly. Run: fly auth login" >&2; exit 1; }

app_exists() { fly status -a "$1" >/dev/null 2>&1; }
# JSON, not the table: the table uses box-drawing separators, so a column
# parse misses existing secrets and a re-run would rotate the password.
has_secret() {
  fly secrets list -a "$1" --json 2>/dev/null | python3 -c '
import json, sys
names = {s.get("Name") or s.get("name") for s in json.load(sys.stdin)}
sys.exit(0 if sys.argv[1] in names else 1)' "$2"
}

step "Apps"
for a in "$REDIS_APP" "$APP"; do
  if app_exists "$a"; then echo "$a exists, skipping"; else fly apps create "$a"; fi
done

step "Redis volume"
if fly volumes list -a "$REDIS_APP" 2>/dev/null | grep -q relay_redis_data; then
  echo "relay_redis_data exists, skipping"
else
  fly volumes create relay_redis_data --size 1 --region "$REGION" -a "$REDIS_APP" --yes
fi

step "Secrets"
if has_secret "$REDIS_APP" REDIS_PASSWORD && has_secret "$APP" REDIS_URL; then
  echo "REDIS_PASSWORD and REDIS_URL already set, skipping (rotate: see runbook)"
else
  PASSWORD="$(openssl rand -hex 32)"
  fly secrets set "REDIS_PASSWORD=$PASSWORD" -a "$REDIS_APP" --stage >/dev/null
  fly secrets set "REDIS_URL=redis://:$PASSWORD@$REDIS_APP.internal:6379" -a "$APP" --stage >/dev/null
  unset PASSWORD
  echo "secrets set (values not shown)"
fi

step "Deploy Redis"
(cd "$ROOT/deploy/redis" && fly deploy -a "$REDIS_APP" --ha=false --wait-timeout 300)

echo
echo "Done. Next: ./scripts/deploy.sh"
