# Self-hosting Brisk (Docker / Compose / Helm)

Brisk's reference target is Cloudflare, but the same Hono core runs as a plain
Node server (`worker/src/index.node.ts`) for self-hosting on a VM or Kubernetes.
This directory packages that assembly: a multi-stage `Dockerfile` (at the repo
root), a Docker Compose stack, and a Helm chart.

Everything is configured with environment variables — the same instance vars as
Cloudflare plus the storage/runtime knobs. See the table in the root
[README → Self-hosting on Node / Kubernetes](../README.md#self-hosting-on-node--kubernetes).

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
# set STORAGE=s3 and the S3_* vars in .env (defaults target the bundled MinIO)
docker compose -f deploy/docker-compose.yml --profile s3 up -d
```

MinIO listens on `:9000` (API) and `:9001` (console). Create the bucket named
in `S3_BUCKET` before first deploy (the console, or `mc mb`).

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
