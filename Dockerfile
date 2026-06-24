# syntax=docker/dockerfile:1

# ---- build: install workspace deps, build SDK + bundle the Node entry ----
FROM node:24-slim AS build
WORKDIR /repo
RUN corepack enable
# Copy the whole monorepo (the .dockerignore keeps it lean) — the build needs
# the sdk to generate worker/assets/brisk.js and the worker to bundle.
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @usebrisk/sdk build \
 && pnpm --filter @usebrisk/worker build:node

# ---- runtime: slim image with only prod deps + the bundle/assets/migrations ----
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    PORT=8787 \
    STORAGE=fs \
    FS_ROOT=/data/objects \
    SQLITE_PATH=/data/brisk.sqlite
WORKDIR /app
# Production deps only. The worker's deps are all public packages (no workspace
# refs), so a standalone install is self-contained.
COPY worker/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund --no-package-lock
# The bundle + the assets/migrations it resolves relative to dist/.
COPY --from=build /repo/worker/dist ./dist
COPY --from=build /repo/worker/assets ./assets
COPY --from=build /repo/worker/migrations ./migrations
# Persisted state (SQLite + fs objects) lives here; mount a volume/PVC.
RUN mkdir -p /data && chown -R node:node /app /data
USER node
VOLUME ["/data"]
EXPOSE 8787
# Non-5xx (incl. 200/302/401) means the server is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node","-e","fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.node.js"]
