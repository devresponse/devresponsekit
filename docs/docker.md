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

The server validates its environment **at boot** (`src/lib/env.ts`) and
exits if a required variable is missing or invalid — so a misconfigured
container fails fast instead of serving broken auth.

**Minimum required to start:**

| Variable | Notes |
| --- | --- |
| `BETTER_AUTH_SECRET` | ≥ 16 chars; signs sessions. Use a unique random value per environment. |
| `BETTER_AUTH_URL` | The app's public base URL, e.g. `https://app.example.com`. |
| `DATABASE_URL` | Postgres connection string. |
| `SSO_HANDOFF_ISSUER` | SSO handoff issuer id. |
| `SSO_HANDOFF_AUDIENCE_PREFIX` | SSO handoff audience prefix. |
| `SSO_HANDOFF_JWT_SECRET` | ≥ 16 chars; independent of `BETTER_AUTH_SECRET`. |

Common optional variables: `DB_SCHEMA` (default `auth`),
`NEXT_PUBLIC_APP_URL`, `ADMIN_TRUSTED_ORIGINS`, the `EMAIL_*` provider keys,
the `API_*` machine-credential switches, `SSO_HANDOFF_APPLICATION_ID`, and
`DOCS_*`. The full, authoritative list with defaults and purpose is in
[`.env.example`](../.env.example) and [configuration.md](configuration.md).

Put the runtime values in a file (do **not** bake them into the image):

```bash
# .env.docker  (NEVER commit this)
BETTER_AUTH_SECRET=...
BETTER_AUTH_URL=https://app.example.com
DATABASE_URL=postgres://app:***@db:5432/app
SSO_HANDOFF_ISSUER=devresponse
SSO_HANDOFF_AUDIENCE_PREFIX=devresponse-app
SSO_HANDOFF_JWT_SECRET=...
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
before the web Deployment rolls out.

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
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: postgres://app:app@db:5432/app
      BETTER_AUTH_SECRET: change-me-min-16-chars
      BETTER_AUTH_URL: http://localhost:3000
      SSO_HANDOFF_ISSUER: devresponse
      SSO_HANDOFF_AUDIENCE_PREFIX: devresponse-app
      SSO_HANDOFF_JWT_SECRET: change-me-min-16-chars

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

- **Pin the base image by digest.** The Dockerfile uses `node:22-bookworm-slim`;
  for byte-for-byte reproducibility, pin it: `FROM node:22-bookworm-slim@sha256:<digest>`.
- **Read-only root filesystem:** `docker run --read-only --tmpfs /tmp …`
  (the standalone server does not write to its own directory).
- **Drop capabilities / no new privileges:**
  `--cap-drop ALL --security-opt no-new-privileges`.
- **Resource limits:** set CPU/memory limits and a restart policy.
- **Secrets:** inject via the orchestrator's secret store, not image layers
  or committed env files.
- **Health probes:** wire the orchestrator's `livenessProbe` to
  `GET /api/health` (200, no DB) and its `readinessProbe` to
  `GET /api/health/ready` (`select 1` → 200, or 503 when the database is
  unreachable). Both are unauthenticated and `no-store`.
- **Graceful shutdown:** the server drains the PostgreSQL pool on `SIGTERM`/
  `SIGINT` before exiting, bounded by `SHUTDOWN_TIMEOUT_MS` (default 10s), so a
  rolling deploy closes DB connections cleanly. Set the orchestrator's
  termination grace period to at least `SHUTDOWN_TIMEOUT_MS`.

---

## 8. Caveats / known limitations

- **In-process rate limiter → single instance is the supported 1.0 topology.**
  The admin abuse-guard rate limiter is per process and not shared across
  replicas, so under horizontal scaling its budget multiplies by the number of
  containers and resets on restart. The **supported 1.0 topology is a single
  application instance**, where the limit enforces one global budget;
  multi-instance still runs but the rate limit is best-effort until a shared
  (Redis/Postgres) backend lands post-1.0. See
  [Deployment → Supported topology](deployment.md#5-operations--gotchas) and
  [troubleshooting.md](troubleshooting.md).
- **Observability is opt-in.** Sentry only initializes when
  `NEXT_PUBLIC_SENTRY_DSN` is set; the image is unchanged otherwise. See
  [configuration.md](configuration.md).
- **In-app docs viewer.** `docs/` is copied into the image so the `/docs`
  viewer works out of the box (it defaults to `<cwd>/docs`). Override with
  `DOCS_ROOT` to serve a different directory (e.g. a mounted volume).
- **Email retries need a scheduled drainer.** `sendAppEmail` attempts delivery
  once inline; a transient provider failure leaves the row retryable in
  `app_outbox`. Run **`pnpm outbox:drain`** periodically (cron / K8s CronJob /
  scheduled task) to re-attempt those rows with backoff until they succeed or
  hit the cap. Like migrations, it needs the dev toolchain (`tsx`, `src/db`),
  so run it from a source checkout or a "tools" image — not the runtime
  container. `OUTBOX_DRAIN_LIMIT` (default 100) bounds rows per run; concurrent
  runs are safe (`FOR UPDATE SKIP LOCKED`).
