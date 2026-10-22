#!/usr/bin/env bash
# STORY-010: deploy Relay to Fly.io, gated by the test suite, with a smoke
# check and automatic rollback. The "deployment fails" failure path:
#
# 1. Gates: type-check and the full test suite (real Redis via Docker) must
#    pass, or nothing is deployed.
# 2. Remembers the image currently running, for rollback.
# 3. Deploys one machine (--ha=false: one machine runs one autoscaler).
#    Fly only marks the release healthy once GET /health passes.
# 4. Smoke check against the public URL: /health/ready must reach Redis and
#    /status.json must not report "down", within ~2 minutes.
# 5. If the deploy or the smoke check fails, redeploys the previous image
#    and exits non-zero.
#
# Usage: ./scripts/deploy.sh [--skip-tests]   (--skip-tests: rollback drills only)
set -euo pipefail

APP="${RELAY_APP:-relay-qn}"
URL="https://$APP.fly.dev"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKIP_TESTS="${1:-}"

step() { printf '\n==> %s\n' "$*"; }

fly auth whoami >/dev/null 2>&1 || { echo "Not logged in to Fly. Run: fly auth login" >&2; exit 1; }

if [ "$SKIP_TESTS" != "--skip-tests" ]; then
  step "Gate: type-check and tests"
  (cd "$ROOT" && docker compose up -d redis >/dev/null)
  (cd "$ROOT/src" && npx tsc --noEmit && npx vitest run)
  (cd "$ROOT/guardrails" && npx vitest run)
fi

step "Remember the running image"
PREVIOUS="$(fly releases -a "$APP" --image --json 2>/dev/null | python3 -c '
import json, sys
try:
    releases = json.load(sys.stdin)
except Exception:
    releases = []
for r in releases:
    if str(r.get("Status", "")).lower() in ("complete", "succeeded"):
        ref = r.get("ImageRef") or r.get("imageRef") or ""
        if ref:
            print(ref)
            break
' || true)"
echo "${PREVIOUS:-none (first deploy: no automatic rollback available)}"

rollback() {
  echo "$1" >&2
  if [ -n "$PREVIOUS" ]; then
    step "Rolling back to $PREVIOUS"
    fly deploy -a "$APP" --image "$PREVIOUS" --ha=false --wait-timeout 300
  else
    echo "No previous image to roll back to. See docs/runbooks/DEPLOYMENT.md." >&2
  fi
  exit 1
}

step "Deploy"
(cd "$ROOT" && fly deploy -a "$APP" --ha=false --wait-timeout 300) || rollback "Deploy failed."

step "Smoke check $URL"
# Resolve through public DNS and pin it: the first deploy's smoke check
# failed with a perfectly healthy app because this machine's resolver had
# cached "not found" for the hostname from before the app existed.
HOST="$APP.fly.dev"
for _ in $(seq 1 24); do
  ip="$(dig +short "$HOST" @1.1.1.1 | grep -E '^[0-9.]+$' | head -1 || true)"
  pin=()
  [ -n "$ip" ] && pin=(--resolve "$HOST:443:$ip")
  ready="$(curl -s "${pin[@]}" -o /dev/null -w '%{http_code}' --max-time 5 "$URL/health/ready" || true)"
  state="$(curl -s "${pin[@]}" --max-time 5 "$URL/status.json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["report"]["state"])' 2>/dev/null || true)"
  if [ "$ready" = "200" ] && [ -n "$state" ] && [ "$state" != "down" ]; then
    echo "ready=$ready state=$state"
    echo "Deployed. Status: $URL/status"
    exit 0
  fi
  sleep 5
done
rollback "Smoke check failed (ready=${ready:-?} state=${state:-?})."
