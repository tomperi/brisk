# Phase 4: Packaging (Docker / Helm / Compose) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Node assembly actually deployable: a multi-stage Dockerfile that bundles the Node entry and ships a slim runtime image, a lean Helm chart (single replica, PVC, Ingress, Secret), and a Docker Compose stack (brisk [+ MinIO]) for local/VM self-hosting — with docs.

**Architecture:** A repo-root `Dockerfile` builds in a Node 24 stage (`pnpm install` → build the SDK into `worker/assets/brisk.js` → `pnpm --filter @usebrisk/worker build:node` → `dist/index.node.js`), then assembles a slim runtime stage with only the production deps, the bundle, `assets/`, and `migrations/`, running as a non-root user. The Helm chart and Compose file are thin wrappers that set the documented env vars and mount a PVC/volume at `/data`. No application code changes — this is packaging only.

**Tech Stack:** Docker (multi-stage, `node:24-slim`), Helm 3, Docker Compose, the existing `build:node` esbuild step.

**Prerequisites:** Phase 3 complete; `pnpm --filter @usebrisk/worker build:node` produces `worker/dist/index.node.js`; the entry resolves `assets`/`migrations` relative to `dist/` (`../assets`, `../migrations`).

---

## Scope decisions

- **Image carries `node_modules` (prod only), not a fully-inlined bundle.** `build:node` uses `--packages=external`, so the runtime needs the prod deps present. A standalone `npm install --omit=dev` in the runtime stage (worker deps are all public: `hono`, `@hono/node-server`, `ws`, `aws4fetch`, `@anthropic-ai/sdk`) keeps the Dockerfile simple and avoids bundler edge-cases with `ws`'s optional natives.
- **Single replica is the default topology** (matches the in-process realtime model). The chart sets `replicaCount: 1` and documents that scaling >1 needs the Redis backplane (Phase 6).
- **`/data` holds both the SQLite file and (in `STORAGE=fs` mode) the objects**, backed by one PVC. The default `values.yaml` uses `STORAGE=fs` for a zero-external-dependency single-pod deploy; switching to S3 is a values change.
- **No HEALTHCHECK via curl** (`node:slim` has no curl); use a Node one-liner that treats any non-5xx as healthy (so a 401 under `AUTH=google` still reads as up).
- **Helm chart lives at `deploy/helm/brisk/`; Compose + Dockerfile context at the repo root.** The Docker build context is the monorepo root (it must build the SDK).

---

## File structure

| File | Responsibility | Action |
| --- | --- | --- |
| `Dockerfile` | multi-stage build → slim runtime image | Create |
| `.dockerignore` | keep the build context lean | Create |
| `deploy/docker-compose.yml` | brisk service + optional MinIO profile | Create |
| `deploy/.env.example` | documented env for Compose | Create |
| `deploy/helm/brisk/Chart.yaml` | chart metadata | Create |
| `deploy/helm/brisk/values.yaml` | default values (fs + SQLite, single replica) | Create |
| `deploy/helm/brisk/templates/_helpers.tpl` | name/label helpers | Create |
| `deploy/helm/brisk/templates/deployment.yaml` | Deployment (1 replica, PVC, env, probes) | Create |
| `deploy/helm/brisk/templates/service.yaml` | ClusterIP Service | Create |
| `deploy/helm/brisk/templates/ingress.yaml` | Ingress (apex + wildcard host) | Create |
| `deploy/helm/brisk/templates/pvc.yaml` | PersistentVolumeClaim for /data | Create |
| `deploy/helm/brisk/templates/secret.yaml` | Secret for sensitive env | Create |
| `deploy/README.md` | how to build/run/deploy | Create |
| `README.md` | link the self-host deploy docs | Modify |

---

## Task 1: Dockerfile + .dockerignore

**Files:** `Dockerfile`, `.dockerignore`

- [ ] **Step 1: Write `.dockerignore`** (repo root)

```
node_modules
**/node_modules
.git
.github
.wrangler
**/.wrangler
.brisk-dev
**/dist
**/.DS_Store
docs/superpowers
.claude
*.log
```

- [ ] **Step 2: Write `Dockerfile`** (repo root)

```dockerfile
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
```

- [ ] **Step 3: Build the image (if Docker is available)**

Run: `docker build -t usebrisk/brisk:dev .` (`run_in_background: true`, from repo root).
Expected: builds successfully. If Docker is NOT available in this environment, skip the build but verify structurally: `pnpm --filter @usebrisk/worker build:node` produces `worker/dist/index.node.js`, and the Dockerfile's `COPY` sources all exist (`worker/dist`, `worker/assets` after an SDK build, `worker/migrations`, `worker/package.json`). Note in the commit message that the image build was/ wasn't run.

- [ ] **Step 4: Smoke the image (if built)**

Run:
```bash
docker run -d --name brisk-smoke -p 8788:8787 -e AUTH=none -v brisk-smoke-data:/data usebrisk/brisk:dev
sleep 3
curl -s http://127.0.0.1:8788/api/me
docker rm -f brisk-smoke && docker volume rm brisk-smoke-data
```
Expected: `{"email":"dev@localhost","name":"Dev"}`. (Skip if Docker unavailable.)

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "feat(deploy): multi-stage Dockerfile for the Node assembly"
```

---

## Task 2: Docker Compose + env example

**Files:** `deploy/docker-compose.yml`, `deploy/.env.example`

- [ ] **Step 1: Write `deploy/docker-compose.yml`**

```yaml
# Local / single-VM self-host. Default: filesystem storage + SQLite on a volume,
# no external services. Enable the `s3` profile to run MinIO and switch STORAGE=s3.
services:
  brisk:
    build:
      context: ..
      dockerfile: Dockerfile
    image: usebrisk/brisk:dev
    restart: unless-stopped
    ports:
      - '${PORT:-8787}:8787'
    environment:
      AUTH: ${AUTH:-none}
      BASE_HOST: ${BASE_HOST:-}
      VISIBILITY: ${VISIBILITY:-private}
      ALLOWED_EMAILS: ${ALLOWED_EMAILS:-}
      ALLOWED_EMAIL_DOMAINS: ${ALLOWED_EMAIL_DOMAINS:-}
      SESSION_SECRET: ${SESSION_SECRET:-}
      GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID:-}
      GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET:-}
      DEPLOY_TOKEN: ${DEPLOY_TOKEN:-}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      OPENAI_API_KEY: ${OPENAI_API_KEY:-}
      # storage: filesystem by default (one volume). Override to s3 with the profile below.
      STORAGE: ${STORAGE:-fs}
      FS_ROOT: /data/objects
      SQLITE_PATH: /data/brisk.sqlite
      S3_ENDPOINT: ${S3_ENDPOINT:-}
      S3_BUCKET: ${S3_BUCKET:-}
      S3_REGION: ${S3_REGION:-us-east-1}
      S3_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID:-}
      S3_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY:-}
    volumes:
      - brisk-data:/data

  # `docker compose --profile s3 up` to run MinIO and back STORAGE=s3.
  minio:
    image: minio/minio:latest
    profiles: ['s3']
    command: server /data --console-address ':9001'
    restart: unless-stopped
    ports:
      - '9000:9000'
      - '9001:9001'
    environment:
      MINIO_ROOT_USER: ${S3_ACCESS_KEY_ID:-minioadmin}
      MINIO_ROOT_PASSWORD: ${S3_SECRET_ACCESS_KEY:-minioadmin}
    volumes:
      - minio-data:/data

volumes:
  brisk-data:
  minio-data:
```

- [ ] **Step 2: Write `deploy/.env.example`**

```sh
# Copy to .env and edit. The defaults run a private, no-auth, filesystem instance.
PORT=8787
AUTH=none                 # or: google
BASE_HOST=                # e.g. brisk.example.com (subdomain URLs)
VISIBILITY=private        # or: public (demo mode)
# When AUTH=google:
SESSION_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
ALLOWED_EMAIL_DOMAINS=    # e.g. yourco.com
DEPLOY_TOKEN=             # optional, for CI deploys
# AI (optional, pass-through):
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
# Storage: fs (default, uses the data volume) or s3.
STORAGE=fs
# When STORAGE=s3 (run `docker compose --profile s3 up` for bundled MinIO):
S3_ENDPOINT=http://minio:9000
S3_BUCKET=brisk
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
```

- [ ] **Step 3: Validate the Compose file**

Run: `cd deploy && docker compose config >/dev/null && echo OK` (`run_in_background: true`). Expected: `OK` (validates syntax + interpolation). If `docker compose` is unavailable, validate the YAML parses (e.g. `python3 -c "import yaml,sys; yaml.safe_load(open('deploy/docker-compose.yml'))"`).

- [ ] **Step 4: Commit**

```bash
git add deploy/docker-compose.yml deploy/.env.example
git commit -m "feat(deploy): docker-compose stack with optional MinIO"
```

---

## Task 3: Helm chart

**Files:** `deploy/helm/brisk/Chart.yaml`, `values.yaml`, `templates/_helpers.tpl`, `templates/deployment.yaml`, `templates/service.yaml`, `templates/ingress.yaml`, `templates/pvc.yaml`, `templates/secret.yaml`

- [ ] **Step 1: `Chart.yaml`**

```yaml
apiVersion: v2
name: brisk
description: Brisk — drop a folder, get a site. Self-hosted on Kubernetes.
type: application
version: 0.1.0
appVersion: '0.1.0'
home: https://github.com/usebrisk/brisk
sources:
  - https://github.com/usebrisk/brisk
```

- [ ] **Step 2: `values.yaml`**

```yaml
# Default: a single pod, filesystem storage + SQLite on one PVC, no external
# services. Realtime is in-process (single replica); scaling >1 needs Redis (not
# yet shipped). Switch storage to S3 by setting config.storage=s3 + s3.*.
replicaCount: 1

image:
  repository: ghcr.io/usebrisk/brisk
  tag: '' # defaults to .Chart.appVersion
  pullPolicy: IfNotPresent

# Non-secret instance config (maps to env vars; see README → Configuration).
config:
  baseHost: '' # e.g. brisk.example.com
  auth: none # or: google
  visibility: private # or: public
  allowedEmails: ''
  allowedEmailDomains: ''
  storage: fs # fs | s3
  sqlitePath: /data/brisk.sqlite
  fsRoot: /data/objects

# S3 (when config.storage=s3). Credentials go in `secrets` below.
s3:
  endpoint: ''
  bucket: ''
  region: us-east-1

# Sensitive values → a Secret. Leave blank to omit. For production, prefer
# `existingSecret` (a Secret you manage) over inlining these in values.
secrets:
  sessionSecret: ''
  googleClientId: ''
  googleClientSecret: ''
  deployToken: ''
  anthropicApiKey: ''
  openaiApiKey: ''
  s3AccessKeyId: ''
  s3SecretAccessKey: ''
existingSecret: '' # name of a pre-created Secret with the same keys; overrides `secrets`

persistence:
  enabled: true
  size: 8Gi
  storageClass: '' # '' = cluster default
  # accessMode ReadWriteOnce suits the single-replica model.
  accessMode: ReadWriteOnce

service:
  type: ClusterIP
  port: 80

ingress:
  enabled: false
  className: ''
  annotations: {}
  # The apex host plus a wildcard for site subdomains (see README → Wildcard subdomains).
  host: brisk.example.com
  wildcard: true # also route *.{host}
  tls:
    enabled: false
    secretName: brisk-tls

resources:
  requests:
    cpu: 50m
    memory: 128Mi
  limits:
    memory: 512Mi

podSecurityContext:
  fsGroup: 1000 # node user — lets the pod write the PVC
nodeSelector: {}
tolerations: []
affinity: {}
```

- [ ] **Step 3: `templates/_helpers.tpl`**

```yaml
{{- define "brisk.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "brisk.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "brisk.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "brisk.labels" -}}
app.kubernetes.io/name: {{ include "brisk.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "brisk.selectorLabels" -}}
app.kubernetes.io/name: {{ include "brisk.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "brisk.secretName" -}}
{{- if .Values.existingSecret }}{{ .Values.existingSecret }}{{ else }}{{ include "brisk.fullname" . }}{{ end -}}
{{- end -}}
```

- [ ] **Step 4: `templates/secret.yaml`**

```yaml
{{- if not .Values.existingSecret }}
apiVersion: v1
kind: Secret
metadata:
  name: {{ include "brisk.fullname" . }}
  labels:
    {{- include "brisk.labels" . | nindent 4 }}
type: Opaque
stringData:
  SESSION_SECRET: {{ .Values.secrets.sessionSecret | quote }}
  GOOGLE_CLIENT_ID: {{ .Values.secrets.googleClientId | quote }}
  GOOGLE_CLIENT_SECRET: {{ .Values.secrets.googleClientSecret | quote }}
  DEPLOY_TOKEN: {{ .Values.secrets.deployToken | quote }}
  ANTHROPIC_API_KEY: {{ .Values.secrets.anthropicApiKey | quote }}
  OPENAI_API_KEY: {{ .Values.secrets.openaiApiKey | quote }}
  S3_ACCESS_KEY_ID: {{ .Values.secrets.s3AccessKeyId | quote }}
  S3_SECRET_ACCESS_KEY: {{ .Values.secrets.s3SecretAccessKey | quote }}
{{- end }}
```

- [ ] **Step 5: `templates/pvc.yaml`**

```yaml
{{- if .Values.persistence.enabled }}
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ include "brisk.fullname" . }}-data
  labels:
    {{- include "brisk.labels" . | nindent 4 }}
spec:
  accessModes:
    - {{ .Values.persistence.accessMode }}
  resources:
    requests:
      storage: {{ .Values.persistence.size }}
  {{- if .Values.persistence.storageClass }}
  storageClassName: {{ .Values.persistence.storageClass }}
  {{- end }}
{{- end }}
```

- [ ] **Step 6: `templates/deployment.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "brisk.fullname" . }}
  labels:
    {{- include "brisk.labels" . | nindent 4 }}
spec:
  # Single replica: realtime is in-process. >1 needs the Redis backplane (Phase 6).
  replicas: {{ .Values.replicaCount }}
  strategy:
    type: Recreate # RWO PVC can't be mounted by two pods during a rollout
  selector:
    matchLabels:
      {{- include "brisk.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "brisk.selectorLabels" . | nindent 8 }}
    spec:
      securityContext:
        {{- toYaml .Values.podSecurityContext | nindent 8 }}
      containers:
        - name: brisk
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - name: http
              containerPort: 8787
          env:
            - { name: PORT, value: "8787" }
            - { name: BASE_HOST, value: {{ .Values.config.baseHost | quote }} }
            - { name: AUTH, value: {{ .Values.config.auth | quote }} }
            - { name: VISIBILITY, value: {{ .Values.config.visibility | quote }} }
            - { name: ALLOWED_EMAILS, value: {{ .Values.config.allowedEmails | quote }} }
            - { name: ALLOWED_EMAIL_DOMAINS, value: {{ .Values.config.allowedEmailDomains | quote }} }
            - { name: STORAGE, value: {{ .Values.config.storage | quote }} }
            - { name: SQLITE_PATH, value: {{ .Values.config.sqlitePath | quote }} }
            - { name: FS_ROOT, value: {{ .Values.config.fsRoot | quote }} }
            {{- if eq .Values.config.storage "s3" }}
            - { name: S3_ENDPOINT, value: {{ .Values.s3.endpoint | quote }} }
            - { name: S3_BUCKET, value: {{ .Values.s3.bucket | quote }} }
            - { name: S3_REGION, value: {{ .Values.s3.region | quote }} }
            {{- end }}
          envFrom:
            - secretRef:
                name: {{ include "brisk.secretName" . }}
          volumeMounts:
            - name: data
              mountPath: /data
          readinessProbe:
            httpGet: { path: /, port: http }
            initialDelaySeconds: 3
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /, port: http }
            initialDelaySeconds: 10
            periodSeconds: 20
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
      volumes:
        - name: data
          {{- if .Values.persistence.enabled }}
          persistentVolumeClaim:
            claimName: {{ include "brisk.fullname" . }}-data
          {{- else }}
          emptyDir: {}
          {{- end }}
      {{- with .Values.nodeSelector }}
      nodeSelector: {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.tolerations }}
      tolerations: {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.affinity }}
      affinity: {{- toYaml . | nindent 8 }}
      {{- end }}
```

> Note: `httpGet: /` returns 200 (`AUTH=none`/public) or 302/401 (`AUTH=google`); Kubernetes treats any 2xx/3xx as success, so the probe is healthy for `none`/`public` and for `google` (302 redirect to login). If you run `AUTH=google` and the probe flaps on a 401 (non-document request), switch the probe path to `/auth/login` (always 302) — documented in `deploy/README.md`.

- [ ] **Step 7: `templates/service.yaml`**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: {{ include "brisk.fullname" . }}
  labels:
    {{- include "brisk.labels" . | nindent 4 }}
spec:
  type: {{ .Values.service.type }}
  selector:
    {{- include "brisk.selectorLabels" . | nindent 4 }}
  ports:
    - name: http
      port: {{ .Values.service.port }}
      targetPort: http
```

- [ ] **Step 8: `templates/ingress.yaml`**

```yaml
{{- if .Values.ingress.enabled }}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "brisk.fullname" . }}
  labels:
    {{- include "brisk.labels" . | nindent 4 }}
  {{- with .Values.ingress.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  {{- if .Values.ingress.className }}
  ingressClassName: {{ .Values.ingress.className }}
  {{- end }}
  {{- if .Values.ingress.tls.enabled }}
  tls:
    - hosts:
        - {{ .Values.ingress.host | quote }}
        {{- if .Values.ingress.wildcard }}
        - {{ printf "*.%s" .Values.ingress.host | quote }}
        {{- end }}
      secretName: {{ .Values.ingress.tls.secretName }}
  {{- end }}
  rules:
    - host: {{ .Values.ingress.host | quote }}
      http: &briskbackend
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ include "brisk.fullname" . }}
                port:
                  name: http
    {{- if .Values.ingress.wildcard }}
    - host: {{ printf "*.%s" .Values.ingress.host | quote }}
      http: *briskbackend
    {{- end }}
{{- end }}
```

- [ ] **Step 9: Lint + render the chart**

Run (if Helm is available): `helm lint deploy/helm/brisk && helm template brisk deploy/helm/brisk --set ingress.enabled=true --set config.auth=google --set secrets.sessionSecret=x >/tmp/brisk-render.yaml && echo OK` (`run_in_background: true`).
Expected: lint passes, template renders without errors, `/tmp/brisk-render.yaml` contains a Deployment, Service, PVC, Secret, and Ingress (with both the apex and `*.host` rules). If Helm is unavailable, validate each template's YAML structure by inspection and confirm every `include`/`.Values` reference resolves to a key defined in `values.yaml`/`_helpers.tpl`.

- [ ] **Step 10: Commit**

```bash
git add deploy/helm
git commit -m "feat(deploy): Helm chart (single replica, PVC, ingress, secret)"
```

---

## Task 4: Docs

**Files:** `deploy/README.md`, root `README.md`

- [ ] **Step 1: Write `deploy/README.md`**

Cover, concretely: (a) building the image (`docker build -t ghcr.io/usebrisk/brisk:<tag> .`) and that it's published to `ghcr.io/usebrisk/brisk`; (b) Docker Compose quickstart (`cp deploy/.env.example deploy/.env`, `docker compose -f deploy/docker-compose.yml up`, then `--profile s3` for MinIO); (c) Helm install (`helm install brisk deploy/helm/brisk --set config.baseHost=brisk.example.com --set ingress.enabled=true --set ingress.className=nginx`, secrets via `--set secrets.sessionSecret=…` or `existingSecret`); (d) the realtime single-replica constraint and `Recreate` strategy with the RWO PVC; (e) storage choice (fs vs s3) and that S3 needs a pre-created bucket; (f) wildcard subdomains/TLS (mirror README → Wildcard subdomains, but for an ingress + cert-manager/ACM); (g) the `AUTH=google` probe note.

- [ ] **Step 2: Link from root `README.md`**

In the "Self-hosting on Node / Kubernetes" section (added in Phase 3), add a pointer to `deploy/README.md` for the Docker/Helm/Compose specifics.

- [ ] **Step 3: Format + commit**

```bash
pnpm format
git add deploy/README.md README.md
git commit -m "docs(deploy): Docker/Helm/Compose self-hosting guide"
```

---

## Task 5: Verification

**Files:** none

- [ ] **Step 1: App still green (packaging shouldn't touch code)**

Run: `cd worker && pnpm test && pnpm typecheck` (`run_in_background: true`). Expected: both projects green, both typechecks clean (unchanged from Phase 3).

- [ ] **Step 2: Bundle still builds**

Run: `cd worker && pnpm run build:node` (`run_in_background: true`). Expected: `dist/index.node.js` produced (the Dockerfile depends on it).

- [ ] **Step 3: Artifact validation (best-effort, per tool availability)**

- If Docker present: `docker build -t usebrisk/brisk:verify .` succeeds, and the smoke run (Task 1 Step 4) returns the dev user.
- If Helm present: `helm lint deploy/helm/brisk` passes and `helm template` renders.
- Compose: `docker compose -f deploy/docker-compose.yml config` validates (or YAML-parses).
- Always: confirm every Dockerfile `COPY --from=build` source path exists after a build, and every Helm `.Values.*` reference has a default in `values.yaml`.

Record in the final report which validations ran live vs. were structural (tool not available).

---

## What Phase 4 leaves for later

- **Phase 5:** the `create-brisk` wizard, which generates a tailored `values.yaml` / `docker-compose.yml` / `.env` / `wrangler.jsonc` from these artifacts as templates.
- **CI:** a GitHub Actions job to build + push the image to `ghcr.io` on tags (can fold into the existing release workflow).
- **Phase 6 (opt-in):** Redis backplane (enables `replicaCount > 1`), Postgres.

---

## Self-review

- **Spec coverage:** Delivers the design's Phase 4 — Dockerfile (bundles via `build:node`, slim non-root runtime), Helm chart (single replica, PVC at `/data`, Ingress with apex + wildcard, Secret), Docker Compose (brisk + optional MinIO), and docs. The realtime single-replica model is encoded (`replicaCount: 1`, `Recreate`, RWO PVC) with Redis flagged as the scale-out path.
- **Placeholder scan:** No TBDs. Tool-dependent validations (docker/helm) have explicit structural fallbacks, since a CI box may lack a Docker daemon.
- **Naming consistency:** Env var names match the Node assembly's `configFromEnv`/`storageFromEnv` (`STORAGE`, `FS_ROOT`, `SQLITE_PATH`, `S3_ENDPOINT`/`S3_BUCKET`/`S3_REGION`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`, plus the shared `BASE_HOST`/`AUTH`/…). The container's `/data` defaults (`FS_ROOT=/data/objects`, `SQLITE_PATH=/data/brisk.sqlite`) match the PVC mount and the Compose volume. The image path `ghcr.io/usebrisk/brisk` is consistent across Dockerfile docs, Helm `values.yaml`, and the Compose image tag.
```
