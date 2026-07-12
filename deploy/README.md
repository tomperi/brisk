# Self-hosting Brisk (Docker / Compose / Helm)

Brisk's reference target is Cloudflare, but the same Hono core runs as a plain
Node server (`worker/src/index.node.ts`) for self-hosting on a VM or Kubernetes.
This directory packages that assembly: a multi-stage `Dockerfile` (at the repo
root), a Docker Compose stack, and a Helm chart.

Everything is configured with environment variables — the same instance vars as
Cloudflare plus the storage/runtime knobs. See [Environment variables](#environment-variables)
below for the full reference; `deploy/.env.example` is a ready-to-copy starting point.

## Environment variables

Every knob is an env var — the same instance vars as the Cloudflare deploy plus
the Node storage/runtime settings. Compose reads them from `deploy/.env` (copy
`deploy/.env.example`); the Helm chart maps the same names from
`values.yaml`/secrets.

| Variable                | Default              | Purpose                                                                                   |
| ----------------------- | -------------------- | ----------------------------------------------------------------------------------------- |
| `AUTH`                  | _(unset → 503)_      | `none` (open, trusted network) or `google`. Unset fails closed on a public ingress.       |
| `BASE_HOST`             | _(none)_             | Apex host, e.g. `brisk.example.com`; each site serves at a subdomain of it.               |
| `VISIBILITY`            | `private`            | `public` opens anonymous view-only (demo mode).                                           |
| `DEPLOY_HISTORY`        | _(off)_              | `on` retains every published version; unset keeps only the live one (bounded storage).    |
| `SESSION_SECRET`        | _(none)_             | Required when `AUTH=google` (cookie signing). Generate with `openssl rand -hex 32`.       |
| `GOOGLE_CLIENT_ID`      | _(none)_             | Google OAuth client id (when `AUTH=google`).                                              |
| `GOOGLE_CLIENT_SECRET`  | _(none)_             | Google OAuth client secret (when `AUTH=google`).                                          |
| `ALLOWED_EMAIL_DOMAINS` | _(none)_             | Comma/space list of allowed sign-in domains, e.g. `yourco.com`.                           |
| `ALLOWED_EMAILS`        | _(none)_             | Comma/space list of individually allowed sign-in emails.                                  |
| `DEPLOY_TOKEN`          | _(none)_             | Optional bearer token for CI deploys.                                                     |
| `ANTHROPIC_API_KEY`     | _(none)_             | Optional; enables the AI proxy (Anthropic).                                               |
| `OPENAI_API_KEY`        | _(none)_             | Optional; AI proxy alternative (provider is picked by whichever key is set).              |
| `STORAGE`               | `s3`                 | `fs` (objects on the data volume) or `s3`. Compose and Helm override the default to `fs`. |
| `SQLITE_PATH`           | `/data/brisk.sqlite` | SQLite database file (always on the volume, in both storage modes).                       |
| `FS_ROOT`               | `/data/objects`      | Object directory when `STORAGE=fs`.                                                       |
| `S3_ENDPOINT`           | _(none)_             | S3-compatible endpoint when `STORAGE=s3`.                                                 |
| `S3_BUCKET`             | _(none)_             | Bucket name when `STORAGE=s3` (**must already exist** — Brisk won't create it).           |
| `S3_REGION`             | `us-east-1`          | Bucket region when `STORAGE=s3`.                                                          |
| `S3_ACCESS_KEY_ID`      | _(none)_             | S3 access key when `STORAGE=s3`.                                                          |
| `S3_SECRET_ACCESS_KEY`  | _(none)_             | S3 secret key when `STORAGE=s3`.                                                          |
| `PORT`                  | `8787`               | HTTP listen port.                                                                         |

## The image

The build context is the **monorepo root** (the build needs the SDK to generate
`worker/assets/brisk.js`). A Node 24 stage installs the workspace, builds the
SDK, and bundles the Node entry (`pnpm --filter @usebrisk/worker build:node` →
`worker/dist/index.node.js`); the runtime stage is a slim `node:24-slim` image
with only the worker's production deps, the bundle, `assets/`, and
`migrations/`, running as the non-root `node` user.

```sh
# from the repo root
docker build -t ghcr.io/usebrisk/brisk:0.1.0 .
docker run -p 8787:8787 -e AUTH=none -v brisk-data:/data ghcr.io/usebrisk/brisk:0.1.0
```

Released images are published to `ghcr.io/usebrisk/brisk`.

## Docker Compose (single VM)

The fastest path for one host. Defaults to filesystem storage + SQLite on a
named volume, no external services.

```sh
cp deploy/.env.example deploy/.env   # edit AUTH, BASE_HOST, secrets…
docker compose -f deploy/docker-compose.yml up -d
```

Open http://localhost:8787 (or your `BASE_HOST`). State lives in the
`brisk-data` volume (`/data/brisk.sqlite` + `/data/objects`).

To use S3-compatible storage with a bundled MinIO instead of the filesystem:

```sh
# STORAGE=s3 switches storage; the S3_* creds/endpoint/bucket default to the
# bundled MinIO, so this works without a .env.
STORAGE=s3 docker compose -f deploy/docker-compose.yml --profile s3 up -d
```

MinIO listens on `:9000` (API) and `:9001` (console). The `s3` profile also runs
a one-shot `createbucket` container that creates `S3_BUCKET` in MinIO (Brisk
never creates the bucket itself), so no manual bucket setup is needed. Point at
an external S3 instead by overriding the `S3_*` vars in `.env`.

## Helm (Kubernetes)

A lean chart: one Deployment (single replica), a Service, an optional Ingress, a
PersistentVolumeClaim for `/data`, and a Secret for sensitive env.

```sh
helm install brisk deploy/helm/brisk \
  --set config.baseHost=brisk.example.com \
  --set config.auth=google \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set secrets.sessionSecret=$(openssl rand -hex 32) \
  --set secrets.googleClientId=… --set secrets.googleClientSecret=…
```

`config.auth` is **empty by default** so the worker fails closed (503) rather
than silently serving an open backend on a public Ingress. A production install
must set `--set config.auth=google` (with `secrets.sessionSecret` and the Google
OAuth creds above). Only set `--set config.auth=none` to deliberately run an open
instance on a trusted network.

Inspect the rendered manifests first with `helm template brisk deploy/helm/brisk …`.

### Secrets

Sensitive values (`SESSION_SECRET`, `GOOGLE_*`, `DEPLOY_TOKEN`,
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `S3_*` credentials) go into a Kubernetes
Secret. Either inline them via `--set secrets.<name>=…` (the chart creates the
Secret) or, for production, pre-create your own Secret with the same keys and
point the chart at it:

```sh
helm install brisk deploy/helm/brisk --set existingSecret=brisk-prod-secrets
```

`existingSecret` overrides the inline `secrets.*` block entirely.

### Single replica, Recreate, RWO PVC

Realtime (db change events, channels, presence) is **in-process**: rooms live in
the pod, so fan-out only works within one replica. The chart therefore pins
`replicaCount: 1` and uses the `Recreate` deploy strategy — a `ReadWriteOnce`
PVC can't be mounted by an old and a new pod at once during a rolling update, so
the old pod is torn down before the new one starts (a few seconds of downtime on
upgrade). Scaling beyond one replica needs a Redis backplane for `Rooms`, which
is a later opt-in; do not raise `replicaCount` until then.

The chart refuses to render with `replicaCount > 1` rather than trusting you to
read this. A second pod would not fail loudly — it would come up healthy, serve
its own in-process rooms (so two users on different pods silently stop seeing
each other's messages, presence, and db events) and, on `storage=s3`, open its
own SQLite file. A template error beats discovering that in production.

### Storage: filesystem vs S3

- `config.storage=fs` (default): SQLite **and** the deployed objects live under
  `/data` on the PVC. Zero external dependencies — right for an internal
  instance. Size the PVC (`persistence.size`, default `8Gi`) for your sites.
- `config.storage=s3`: objects go to an S3-compatible bucket; SQLite still lives
  on the PVC (you can shrink it). Set `s3.endpoint`, `s3.bucket`, `s3.region`
  and the `secrets.s3AccessKeyId` / `secrets.s3SecretAccessKey` credentials. The
  **bucket must already exist** — Brisk does not create it.

### Wildcard subdomains and TLS

Brisk serves each site at a subdomain of `BASE_HOST` (e.g.
`my-site.brisk.example.com`); the dashboard and APIs live on the apex. With
`ingress.enabled=true` and `ingress.wildcard=true` (the default) the chart emits
two rules — the apex host and `*.{host}` — both routed to the Service.

Point a DNS A/CNAME record for both the apex and the wildcard
(`*.brisk.example.com`) at your ingress controller. For TLS you need a
**wildcard certificate** covering `brisk.example.com` and `*.brisk.example.com`:

- **cert-manager:** request a wildcard cert via a DNS-01 issuer (HTTP-01 can't
  validate wildcards), then set `ingress.tls.enabled=true` and
  `ingress.tls.secretName` to the resulting Secret.
- **AWS ACM / cloud LB:** issue the wildcard cert in ACM and reference it via the
  ingress controller's annotations (`ingress.annotations`); leave
  `ingress.tls.enabled=false` since the LB terminates TLS.

### Health probes

The readiness/liveness probes hit `healthcheck.path`, which defaults to
`/auth/login`. That route 302s for a probe request (a non-document `GET`) in
every `AUTH` mode — to `/` under `AUTH=none` and to Google under `AUTH=google` —
and Kubernetes treats 3xx as healthy. Probing `/` instead would crash-loop under
`AUTH=google`: the auth gate only 302s a _browser_ (a `GET` with
`Sec-Fetch-Dest: document` or an `Accept: text/html`), and a kube-probe sends
neither, so it gets a `401` — a probe failure. Keep the default unless you run
`AUTH=none`, where `/` returns `200`.

### Locking down egress

Brisk serves folders that other people dropped on it and proxies AI calls for
them, so the pod is best treated as untrusted code that happens to have a
network. `networkPolicy.enabled=true` emits an **egress-only** NetworkPolicy that
allows DNS and the public internet (so `brisk.ai` still works) and denies the
RFC1918 ranges where the rest of your cluster lives, plus `169.254.0.0/16` — the
link-local range that on AWS is the IMDS credential endpoint. Ingress is left
alone, so the ingress controller and kube-probes still reach the pod.

It is off by default: it does nothing on a CNI that doesn't enforce
NetworkPolicy, and it would **block an S3 endpoint that lives inside the
cluster** — if you run `storage=s3` against an in-cluster MinIO, either leave
this off or drop that range from `networkPolicy.denyCIDRs`. Same if you move AI
to a provider reached over link-local metadata credentials (e.g. Bedrock via
IRSA): remove `169.254.0.0/16` or the credential fetch fails.

### Backups

**The volume is the database.** SQLite (`/data/brisk.sqlite`) holds every site
record, and under `storage=fs` `/data/objects` holds every file of every
deployed site. Nothing here replicates it and the chart ships no backup job — if
that PVC is lost, every site is lost. SQLite runs in WAL mode, so it survives a
crash; it does not survive a deleted volume.

At minimum:

- Use a StorageClass with `reclaimPolicy: Retain`, so deleting the PVC (or the
  Helm release) doesn't take the underlying disk with it. A `Delete` policy —
  the default on many clusters — makes `helm uninstall` unrecoverable.
- Snapshot the volume on a schedule (VolumeSnapshot, or your cloud's disk
  snapshots).
- To back up a running instance, take the DB with SQLite's own backup command and
  archive `/data/objects` alongside it. A plain `cp` of a live WAL database can
  copy a torn page; `.backup` can't.

```sh
kubectl exec deploy/brisk -- sqlite3 /data/brisk.sqlite ".backup /tmp/brisk.bak"
kubectl cp brisk-<pod>:/tmp/brisk.bak ./brisk.bak
```

`storage=s3` moves the objects out of the volume, which shrinks the blast radius
to SQLite alone — but SQLite is still the index that maps sites to those objects,
so it still needs backing up.
