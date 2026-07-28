# syntax=docker/dockerfile:1

# ---- build: install workspace deps, build SDK + bundle the Node entry ----
FROM node:24-slim AS build
WORKDIR /repo
RUN corepack enable
# Copy the whole monorepo (the .dockerignore keeps it lean) — the build needs
# the sdk to generate worker/assets/brisk.js and the worker to bundle.
COPY . .
# Generate the built assets (brisk.js via the sdk, changelog.html from
# CHANGELOG.md, plugin widget bundles — all gitignored, so absent unless
# produced here; without build:widgets the injected /_plugins/<id>/widget.js
# 404s and the plugin is silently dead), bundle the Node entry, then materialize
# a self-contained, lockfile-pinned production node_modules under /prod.
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @usebrisk/sdk build \
 && node worker/scripts/build-changelog.mjs \
 && pnpm --filter @usebrisk/worker build:widgets \
 && pnpm --filter @usebrisk/worker build:node \
 && pnpm --filter @usebrisk/worker --legacy deploy --prod --frozen-lockfile /prod

# ---- runtime: slim image with only prod deps + the bundle/assets/migrations ----
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    PORT=8787 \
    STORAGE=fs \
    FS_ROOT=/data/objects \
    SQLITE_PATH=/data/brisk.sqlite
WORKDIR /app
# Production deps, resolved from the frozen lockfile in the build stage (pnpm
# deploy), so a rebuilt tag installs the exact versions that were tested rather
# than drifting off the `^` ranges. package.json carries `type: module` for the
# ESM bundle and the version metadata.
COPY --from=build /prod/node_modules ./node_modules
COPY worker/package.json ./package.json
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
