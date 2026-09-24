---
title: Docker
description: Build and run the production multi-stage container from Next.js standalone output.
group: General
order: 65
---

# Running devresponsekit in Docker

The repository ships a production **`Dockerfile`** (multi-stage) and a
**`.dockerignore`** that build a small, non-root container from Next.js'
standalone output (`output: "standalone"` in `next.config.mjs`).

The final image is essentially `node server.js` plus only the runtime
dependencies Next traced — not the full repo, dev dependencies, or build
toolchain. A typical image is a few hundred MB rather than the ~1 GB a
naïve `COPY . .` image would produce.

> **TL;DR**
>
> ```bash
> docker build -t devresponsekit .
> docker run --rm -p 3000:3000 --env-file .env.docker devresponsekit
> ```
>
> …after running the database migrations as a **separate** step (below).

---

## 1. What the image contains (and does not)

| Included | Not included |
| --- | --- |
| The standalone Next.js server (`server.js`) | Dev dependencies / build toolchain |
| Traced runtime `node_modules` | The Postgres database (run it separately) |
| `.next/static`, `public/` | Migration / seed scripts (`tsx`, `src/db/**`) |
| `docs/` (source for the in-app `/docs` viewer) | Your `.env` / secrets (passed at runtime) |
| `help/` (source for the in-app help viewer) | The `npm` / `npx` / `corepack` / `yarn` CLIs (deleted from the runner stage, see §7) |

Because the migration and seed scripts (`pnpm db:*`, which use `tsx`) are
**not** in the runtime image, this container **never runs migrations on
start**. Migrations are a deliberate, separate step — see §4.

---

## 2. Build

Prerequisites: Docker with BuildKit (Docker 23+ enables it by default).

```bash
docker build -t devresponsekit:latest .
```

No secrets are needed at build time. `next build` runs with
`NEXT_PHASE=phase-production-build`, so `src/lib/env.ts` substitutes
placeholder values and nothing real is baked into the image. (Sentry
source-map upload stays disabled unless you pass `SENTRY_AUTH_TOKEN` as a
build arg — see [configuration.md](configuration.md).)

---

## 3. Configure (environment variables)

The server validates its environment **at boot** (`src/lib/env.ts`, parsed
by `register()` in `src/instrumentation.ts` before the first request) and
exits with code 1 if a required variable is missing or invalid, naming each
variable and the rule it broke — so a misconfigured container fails fast
instead of serving broken auth. Until F-26 that parse waited for the first
request that needed a value, and a container with, say, a 20-character
`BETTER_AUTH_SECRET` stayed up and reported healthy while every page that
touched auth answered 500.

**Minimum required to start:**

| Variable | Notes |
| --- | --- |
| `BETTER_AUTH_SECRET` | ≥ 32 chars; signs sessions. Use a unique random value per environment. |
| `BETTER_AUTH_URL` | The app's public base URL, e.g. `https://app.example.com`. |
| `DATABASE_URL` | Postgres connection string. |
| `SSO_HANDOFF_ISSUER` | SSO handoff issuer — the primary's **origin URL** (consumers fetch its public keys from `${SSO_HANDOFF_ISSUER}/api/sso/jwks.json`). |
| `SSO_HANDOFF_AUDIENCE_PREFIX` | SSO handoff audience prefix. |
| `SSO_HANDOFF_APPLICATION_ID` | This deployment's application id (required at boot even if SSO is unused). |

Optional: `SSO_HANDOFF_PRIVATE_KEY` — the Ed25519 private JWK that **signs** handoffs; set it **only on the issuer** (satellites verify against the issuer's JWKS and hold no key). Without it the instance still consumes handoffs but `/api/sso/launch` answers 503. Generate one with the command in [configuration.md → SSO handoff](configuration.md#single-sign-on-handoff).

Common optional variables: `DB_SCHEMA` (default `auth`),
`NEXT_PUBLIC_APP_URL`, `ADMIN_TRUSTED_ORIGINS`, the `EMAIL_*` provider keys,
the `API_*` machine-credential switches, and
`DOCS_*`. The full, authoritative list with defaults and purpose is in
[`.env.example`](../.env.example) and [configuration.md](configuration.md).

Put the runtime values in a file (do **not** bake them into the image):

```bash
# .env.docker  (NEVER commit this)
BETTER_AUTH_SECRET=...
BETTER_AUTH_URL=https://app.example.com
DATABASE_URL=postgres://app:***@db:5432/app
SSO_HANDOFF_ISSUER=https://app.example.com
SSO_HANDOFF_AUDIENCE_PREFIX=devresponse-app
SSO_HANDOFF_APPLICATION_ID=main
# issuer only — Ed25519 private JWK (JSON); omit on satellites
SSO_HANDOFF_PRIVATE_KEY={"kty":"OKP","crv":"Ed25519","x":"...","d":"..."}
```

In production, prefer your orchestrator's secret mechanism (Kubernetes
Secrets, ECS task secrets, Fly secrets, etc.) over an `--env-file`.

> **Do not set `SKIP_ENV_VALIDATION` or `AUTH_RATE_LIMIT_DISABLED` in a
> production container** — the env schema refuses both when
> `NODE_ENV=production` (outside CI), since they would weaken auth.

---

## 4. Migrate the database (separate step, before traffic)

Run migrations once per deploy, from a **source checkout** (or a dedicated
init job / "migrator" container that has the dev toolchain), pointed at the
production `DATABASE_URL` — never from the web container:

```bash
DATABASE_URL=postgres://app:***@db:5432/app DB_SCHEMA=auth \
  pnpm db:auth:migrate   # Better Auth identity tables
DATABASE_URL=... DB_SCHEMA=auth pnpm db:app:migrate   # application schema
DATABASE_URL=... DB_SCHEMA=auth pnpm db:seed          # first deploy only: baseline org/roles/admin
```

Apply migrations **before** routing traffic to a new image. In an
orchestrator this is a pre-deploy job / init container that must succeed
before the web Deployment rolls out. Run **both** migrators on every deploy,
not only the first: a better-auth upgrade or a new plugin changes the Better
Auth tables (`src/db/migrations/better-auth-schema.sql`), and the readiness
probe answers `503 schema_behind` for a gap in either half (§7).
`db:auth:migrate` loads the app's auth configuration, so it needs the
required variables of §3 in the shell or the checkout's `.env`; the Better
Auth schema does not depend on their values, which is why
`.github/workflows/deploy.yml` runs it with CI placeholders.

---

## 5. Run

```bash
docker run --rm -p 3000:3000 --env-file .env.docker devresponsekit:latest
```

The standalone server reads `PORT` (default `3000`) and `HOSTNAME`
(set to `0.0.0.0` in the image so it accepts external connections). It runs
as the unprivileged `nextjs` user.

Terminate TLS at a reverse proxy / load balancer in front of the container
and set `BETTER_AUTH_URL` / `NEXT_PUBLIC_APP_URL` to the public `https://`
origin.

**Do not publish port 3000 straight to clients.** The per-IP limits (Better
Auth's sign-in limiter included) and the IPs on audit rows and sessions come from
a request header, and with nothing in front of the container every such header is
one the client sends: a random `X-Forwarded-For` per request is a fresh sign-in
bucket, which means unlimited password guessing (F-17). The proxy in front must
either **overwrite or append to** the client's `X-Forwarded-For` (keep the default
`CLIENT_IP_SOURCE=xff`), or set a header of its own and name it, for example
`CLIENT_IP_SOURCE=x-real-ip` behind nginx `proxy_set_header X-Real-IP $remote_addr;`.
Set `CLIENT_IP_SOURCE` explicitly either way: a production container without it logs
a warning at boot. See
[Choosing the client-IP source](./configuration.md#choosing-the-client-ip-source).

### docker compose (app + Postgres) for local or single-host

```yaml
services:
  db:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    volumes: ["dbdata:/var/lib/postgresql/data"]

  migrate:
    build: .
    # The runtime image has no migration tooling, so run migrations from a
    # source checkout / CI step instead, OR build a separate image whose
    # CMD is `pnpm db:auth:migrate && pnpm db:app:migrate`. Shown here as a
    # reminder that this is a distinct, run-once step gating `app`.
    profiles: ["tools"]

  app:
    build: .
    depends_on: [db]
    # Local use only. On a real host, publish a reverse proxy instead and let
    # only it reach this port: with nothing in front, a client-sent
    # X-Forwarded-For picks its own rate-limit bucket (see section 5).
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: postgres://app:app@db:5432/app
      BETTER_AUTH_SECRET: change-me-to-a-random-32char-min-secret
      BETTER_AUTH_URL: http://localhost:3000
      SSO_HANDOFF_ISSUER: http://localhost:3000
      SSO_HANDOFF_AUDIENCE_PREFIX: devresponse-app
      SSO_HANDOFF_APPLICATION_ID: main
      # Issuer only: an Ed25519 private JWK (JSON string) — generate one with the
      # command in configuration.md; leave unset on a consumer-only satellite.
      # SSO_HANDOFF_PRIVATE_KEY: '{"kty":"OKP","crv":"Ed25519","x":"...","d":"..."}'

volumes:
  dbdata:
```

---

## 6. Deploy

1. Build and tag with an immutable tag (a commit SHA, not `latest`):
   `docker build -t REGISTRY/devresponsekit:$GIT_SHA .`
2. Push: `docker push REGISTRY/devresponsekit:$GIT_SHA`.
3. Run the migration step (§4) against the target database.
4. Roll out the new image; route traffic once it is healthy.

---

## 7. Hardening (recommended for production)

- **Base image is pinned by digest — keep it current.** Both stages use
  `FROM node:24-bookworm-slim@sha256:<digest>` (the multi-arch index digest,
  identical in both `FROM` lines) for byte-for-byte reproducibility.
  Dependabot's `docker` ecosystem (`.github/dependabot.yml`) opens a PR when
  the tag moves to a new digest; to bump by hand, take the `digest` field from
  `https://hub.docker.com/v2/repositories/library/node/tags/22-bookworm-slim`
  and update both lines together. The weekly Trivy scan
  (`.github/workflows/docker-scan.yml`, a required check) goes red when a
  stale base image accumulates fixable HIGH/CRITICAL CVEs, so a digest bump is
  the usual fix for a base-OS finding.
- **No package-manager CLIs in the runtime image.** The runner stage deletes
  the `npm`, `npx`, `corepack`, and `yarn` binaries (and npm's vendored
  `node_modules`) that the Node base image bundles. The container only ever
  runs `node server.js`, so nothing is lost — and npm's own dependency tree
  (tar, pacote, sigstore, minimatch, …) can no longer produce "fixable
  HIGH/CRITICAL" Trivy findings that are unreachable in production. If you
  `docker exec` into a container, expect `npm`/`npx` to be absent by design.
- **Read-only root filesystem:** `docker run --read-only --tmpfs /tmp …`
  (the standalone server does not write to its own directory).
- **Drop capabilities / no new privileges:**
  `--cap-drop ALL --security-opt no-new-privileges`.
- **Resource limits:** set CPU/memory limits and a restart policy.
- **Secrets:** inject via the orchestrator's secret store, not image layers
  or committed env files.
- **Health probes:** wire the orchestrator's `livenessProbe` to
  `GET /api/health` (200, no DB) and its `readinessProbe` to
  `GET /api/health/ready` (200 when the environment passes its schema, the
  database is reachable, the `app_schema_migrations` ledger holds every core
  migration the image was built with **and** Better Auth's own schema check
  finds every table and column its configuration writes; 503
  `config_invalid`, `database_unreachable` or `schema_behind` otherwise,
  with the detail in the log and never in the body). Because readiness covers
  both schemas, a rolling update of an image whose migration has not been
  applied **stalls** on unready pods instead of routing traffic to code that
  would 500 — run the migrate init step and the pods become ready. One
  exception, from Better Auth (F-26): a pod that started while a Better Auth
  table or column was missing keeps that verdict, and keeps refusing every
  auth request, until it restarts; migrating fixes new pods, so restart the
  ones that already report `schema_behind`. The image's own `HEALTHCHECK`
  uses the same readiness probe. Both probes are unauthenticated and
  `no-store`.
- **Graceful shutdown:** on `SIGTERM`/`SIGINT` two things run, in this order
  (review #24). **(1)** Next's own signal cleanup (`node server.js` →
  `start-server.js`) stops accepting connections, waits for every in-flight
  request — and therefore every query it issues — to finish, then exits with
  the signal code (`143` for SIGTERM, `130` for SIGINT); the PostgreSQL pool
  is deliberately **not** ended during that window, because ending it fails
  any request between two queries (`Cannot use a pool after calling end`) —
  the idle sockets are closed by the OS at exit, which Postgres treats as an
  ordinary disconnect. **(2)** The app's watchdog, armed by the same signal,
  ends the pool and exits with the same signal code **only if** that drain
  overruns `SHUTDOWN_TIMEOUT_MS` (default 10s), so a wedged request can never
  hang the shutdown. Set the orchestrator's termination grace period
  **above** `SHUTDOWN_TIMEOUT_MS`, treat exit code 143 as a normal signal
  stop, and do **not** set `NEXT_MANUAL_SIG_HANDLE` (it removes step 1, so
  the process would exit after the budget without draining HTTP).

---

## 8. Caveats / known limitations

- **Rate limiting across replicas: the security floors are shared, the
  per-actor guards are not.** The **pre-auth floors** — the token endpoint,
  MCP registration, the CSP report sink, SSO consume and a signed-out SSO
  launch, invitation acceptance — and Better Auth's own sign-in /
  password-reset limiter keep their buckets in Postgres (`app_rate_limits`
  from migration `0006`, and Better Auth's `rateLimit` table from
  `pnpm db:auth:migrate`), so they enforce **one budget across every
  container**. The **admin per-actor** abuse guard (mutations, bulk, export,
  a signed-in SSO launch) is still per process: under horizontal scaling its
  budget multiplies by the number of containers and resets on restart. That
  guard layers on top of authorization, so multi-instance is supported; only
  the per-actor UX limit is best-effort there. See
  [Deployment → Operations & gotchas](deployment.md#5-operations--gotchas) and
  [troubleshooting.md](troubleshooting.md).
- **Observability is opt-in.** Sentry only initializes when
  `NEXT_PUBLIC_SENTRY_DSN` is set; the image is unchanged otherwise. See
  [configuration.md](configuration.md).
- **In-app docs + help viewers.** `docs/` and `help/` are copied into the
  image so both viewers work out of the box (they default to `<cwd>/docs`
  and `<cwd>/help`). Override with `DOCS_ROOT` / `HELP_ROOT` to serve a
  different directory (e.g. a mounted volume). The screenshot capture tool
  beside the help content (`help/capture.mjs`) is operator tooling and is
  excluded from the build context by `.dockerignore`, so the image holds only
  servable content.
- **Email retries need a scheduled drainer.** `sendAppEmail` attempts delivery
  once inline; a transient provider failure leaves the row retryable in
  `app_outbox`. Run **`pnpm outbox:drain`** periodically (cron / K8s CronJob /
  scheduled task) to re-attempt those rows with backoff until they succeed or
  hit the cap. Like migrations, it needs the dev toolchain (`tsx`, `src/db`),
  so run it from a source checkout or a "tools" image — not the runtime
  container. `OUTBOX_DRAIN_LIMIT` (default 100) bounds rows per run; concurrent
  runs are safe (`FOR UPDATE SKIP LOCKED`).
- **MCP self-registration needs a scheduled reaper** (only if
  `MCP_REGISTRATION_ENABLED`). Run **`pnpm mcp:reap`** periodically the same
  way to expire registrations still pending after
  `MCP_REGISTRATION_PENDING_TTL_DAYS` (default 7), so junk registrations do not
  pile up in the Agents console. Same toolchain caveat as the drainer.
