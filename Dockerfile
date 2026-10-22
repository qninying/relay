# STORY-010 (REQ-009): Relay's production image. Same pattern as CoreOps's
# Dockerfile, with one difference: Relay runs compiled JavaScript, not tsx.
# The server forks one Node process per worker (STORY-006), and tsx's
# per-process overhead would push three workers past a 512MB machine.
#
# Layout inside the image mirrors the repo, so every relative path the source
# uses (../guardrails, ../taxonomies, dashboard.html next to the server)
# resolves the same way it does in development and tests.

# ---- build ------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app/src
COPY src/package.json src/package-lock.json ./
RUN npm ci
COPY src/ ./
COPY guardrails/*.ts /app/guardrails/
RUN npm run build

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
RUN apk add --no-cache dumb-init
WORKDIR /app/src
COPY src/package.json src/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/src/dist ./dist
COPY src/dashboard.html ./dist/src/dashboard.html
COPY taxonomies ./dist/taxonomies

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER node

# Liveness only (GET /health has no dependencies), so a Redis outage shows as
# "down" on the status page instead of restart-looping the container.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# dumb-init: Node ignores SIGTERM as PID 1. Without it a deploy would wait
# out the grace period and SIGKILL the server, instead of letting workers
# finish the job they hold (server.ts shutdown()).
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/src/server.js"]
