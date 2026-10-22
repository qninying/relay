#!/bin/sh
# STORY-010: start Redis for Relay on Fly.io.
#
# --requirepass     from the REDIS_PASSWORD secret; refuses to start without
#                   one rather than run an open Redis.
# --appendonly yes  every write is persisted to the /data volume.
# --maxmemory-policy noeviction
#                   Relay's queue must never silently lose entries to make
#                   room. When memory is full, writes fail loudly instead
#                   (enqueue errors are logged by the app) and existing jobs
#                   are kept.
# --maxmemory 180mb leaves headroom on the 256MB machine.
# --bind 0.0.0.0 ::  Fly's private network is IPv6.
set -eu

if [ -z "${REDIS_PASSWORD:-}" ]; then
  echo "start-redis: REDIS_PASSWORD is not set; refusing to start an unauthenticated Redis" >&2
  exit 1
fi

exec redis-server \
  --dir /data \
  --appendonly yes \
  --requirepass "$REDIS_PASSWORD" \
  --maxmemory 180mb \
  --maxmemory-policy noeviction \
  --bind 0.0.0.0 :: \
  --protected-mode no
