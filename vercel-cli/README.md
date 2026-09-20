# drk-deploy

A command-line client that deploys **devresponsekit** to Vercel: project link, environment
variables, Postgres, migrations, promotion and verification — in the one order that is safe.

It exists because the deployment has four moving parts that must happen in sequence, and the
consequences of getting the order wrong are not subtle: a build promoted ahead of its schema
serves 500s until someone notices.

```cmd
drk-deploy up
```

That single command syncs the environment, migrates the database, builds, promotes, and then
probes the result to prove it works.

---

## Install

Requires **Node 24+** and **pnpm**, the same toolchain the kit itself uses.

```cmd
cd /d C:\my\repos\devresponsekit\vercel-cli
pnpm install
pnpm build
```

Then call it by path, or put this folder on your `PATH`:

```cmd
C:\my\repos\devresponsekit\vercel-cli\drk-deploy.cmd --help
```

The `.cmd` wrapper works from both `cmd.exe` and PowerShell. On macOS or Linux use
`node dist/index.js` (or `npm link`).

---

## First deployment

```cmd
drk-deploy login                     :: store a Vercel access token
drk-deploy init --project my-app --domain app.example.com
drk-deploy doctor                    :: check the toolchain before changing anything
drk-deploy db:provision              :: optional — create a marketplace Postgres
drk-deploy up --from-env .env.production
```

`--from-env` supplies the values that cannot be generated — principally `DATABASE_URL`. Anything
the CLI _can_ generate (signing keys, cron tokens) it generates.

---

## Commands

| Command        | What it does                                                                                |
| -------------- | ------------------------------------------------------------------------------------------- |
| `login`        | Stores a Vercel token, after proving it works. Saved to your user profile, never the repo.  |
| `init`         | Links this checkout to a Vercel project and records the origin, app name and kit path.      |
| `doctor`       | Checks Node, pnpm, the Vercel CLI, credentials and the project link. Changes nothing.       |
| `status`       | Project, latest production deployment, and a live health probe.                             |
| `env:check`    | Reports missing, invalid and must-not-be-set variables. Exit 1 if anything needs attention. |
| `env:sync`     | Creates every variable the kit needs, generating the secrets it can.                        |
| `env:prune`    | Removes development-only variables that should never exist on a deployment.                 |
| `db:provision` | Creates a marketplace Postgres store and connects it to the project.                        |
| `db:status`    | Shows the database variables wired into the project.                                        |
| `migrate`      | Applies the kit's migrations to the target database.                                        |
| `deploy`       | Migrate → build → promote → verify.                                                         |
| `up`           | `env:sync` then `deploy`. The whole thing.                                                  |

Every command accepts `--dry-run`, and every command is safe to re-run.

---

## What it does about the things that go wrong

**Migrations run before promotion.** `deploy` applies migrations first and promotes only if they
succeed. If a migration fails, the currently-live build keeps serving against the schema it
understands, and nothing is promoted. This is the ordering the repo's own deploy workflow
documents, and the reason it is documented is that the reverse has caused outages.

**A pooled connection string is refused.** Migrations need the _direct_ endpoint: DDL and the
advisory lock the migration runner takes do not survive a transaction pooler, and the failure is
silent rather than loud. Pass `--allow-pooled` only if you know why you are doing it.

**Secrets are never printed.** Values reach the terminal only through a mask that shows a length
and a short fingerprint (`(set, 44 chars, fp 3f8a1c2d)`) — enough to compare two runs, useless to
anyone reading over your shoulder or scrolling a CI log. Secrets are never passed as command-line
arguments either, because an argument list is visible to other processes and lands in shell
history; they travel in the child process's environment instead.

**Re-running does not rotate anything.** `env:sync` leaves existing variables alone. Overwriting
takes `--force`, and rotating a secret additionally takes `--yes`, because rotating
`BETTER_AUTH_SECRET` signs out every active user.

**The deployment is verified, not assumed.** After promoting, the CLI probes `/api/health`,
`/api/health/ready` and a deliberately-wrong sign-in. A 401 on that last one means auth is alive;
a 500 means the build is up but broken. It also checks that the SSO issuer publishes a key — an
empty key set means no satellite can verify a handoff, which is invisible from the dashboard.

---

## The environment contract

The kit validates its environment once at boot and refuses to start if a required variable is
missing or malformed. Six are required:

| Variable                      | Generated?                              |
| ----------------------------- | --------------------------------------- |
| `BETTER_AUTH_SECRET`          | yes — 32 bytes of entropy               |
| `BETTER_AUTH_URL`             | derived from the domain you gave `init` |
| `DATABASE_URL`                | supplied, or injected by `db:provision` |
| `SSO_HANDOFF_ISSUER`          | derived                                 |
| `SSO_HANDOFF_AUDIENCE_PREFIX` | derived                                 |
| `SSO_HANDOFF_APPLICATION_ID`  | derived                                 |

Two more matter even though the app boots without them: `SSO_HANDOFF_PRIVATE_KEY` (an Ed25519
JWK — without it the SSO launch endpoint answers 503 and the published key set is empty) and
`CRON_SECRET` (without it both scheduled jobs answer 401 forever, silently). `env:sync` generates
both.

A note worth internalising: `NEXT_PUBLIC_*` values are compiled into the client bundle at build
time. Changing one in the dashboard does nothing until the next deployment.

---

## Postgres

Vercel's Postgres is delivered by marketplace partners. Installing an integration is an
interactive consent flow that an API token cannot complete, so:

```cmd
vercel integration add neon     :: once, interactively
drk-deploy db:provision         :: thereafter, from here
```

`db:provision` creates a store on the installed integration and connects it to the project, which
injects the connection variables. Marketplace Postgres usually injects both a pooled and a direct
string — migrations must use the direct one.

---

## Using it from CI

Set `VERCEL_TOKEN` and it takes precedence over any saved credential:

```yaml
- run: pnpm install && pnpm build
  working-directory: vercel-cli
- run: node dist/index.js up --yes
  working-directory: vercel-cli
  env:
    VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
    PRODUCTION_DIRECT_DATABASE_URL: ${{ secrets.PRODUCTION_DIRECT_DATABASE_URL }}
```

If this becomes the deployment path, turn off Vercel's automatic production deploys for the
project — otherwise a push promotes a build before this has migrated anything, which is the exact
race the ordering above exists to prevent.

---

## Development

```cmd
pnpm typecheck
pnpm test           :: builds, then runs the unit tests
pnpm format
```

This package is deliberately excluded from the kit's own typecheck, lint and format runs: it has
its own `tsconfig.json` and dependency tree, and the kit's required checks gate a repository whose
`main` branch deploys to production.

Files: `src/lib/env-spec.ts` is the environment contract, and the one to edit when the kit's
`src/lib/env.ts` changes. `src/lib/vercel-client.ts` wraps `@vercel/sdk`. `src/commands/` is one
file per command group.

---

## Dependency override floors

Everything this CLI ships is transitive: the only direct dependencies are `@vercel/sdk`,
`vercel` and `commander`. When an advisory lands inside that tree there is usually nothing to
upgrade — `vercel` is already on its latest version and pins the vulnerable package itself —
so the fix is a floor in `pnpm.overrides`, not a mute. The floors below took this package from
50 advisories (1 critical, 20 high) to none.

| Override | Floor | Advisory / reason |
| --- | --- | --- |
| `tar@7` | `^7.5.21` | Nine advisories, one **critical**. Reached through the CLI's archive handling. |
| `undici@5` → `undici` | `^6.28.0` | **A deliberate major.** Most undici advisories affecting the installed 5.x line are only patched in 6.x, so there is no in-major fix; `@vercel/node` pins 5.28.4. See the note below. |
| `js-yaml@4` | `^4.3.2` | Four advisories, worst high. |
| `minimatch@10` | `^10.2.3` | Three advisories, high. The 3.x copy in the tree is unaffected and deliberately untouched. |
| `path-to-regexp@8` | `^8.4.0` | Three advisories. |
| `path-to-regexp@6` | `^6.3.0` | GHSA-9wv6-86v2-598j (high, backtracking regex). `@vercel/node` pulls **both** 6.1.0 and 6.3.0; only the former is vulnerable. Note `pnpm audit` does **not** report this one — GitHub's advisory database does. Check both. |
| `smol-toml@1` | `^1.7.1` | Two advisories, worst high. |
| `ajv@8` | `^8.18.0` | One moderate. |
| `@tootallnate/once@2` | `^2.0.1` | One low. |

**Why the undici major is safe here.** The vulnerable copy is reached only through
`vercel > @vercel/{elysia,express,fastify,h3,hono,koa,…} > @vercel/node`, the framework
adapters for standalone serverless functions. This CLI deploys a **Next.js** application,
which is built by `@vercel/next`, so those adapters are installed but never executed. The
override was verified rather than assumed: after forcing it, the package builds, its own test
suite passes, the bundled `vercel` CLI still reports its version, and both `drk-deploy doctor`
and `drk-deploy status` complete against the live Vercel API, which exercises the real HTTP
path end to end.

Re-check with `pnpm audit --audit-level low` from this directory. If a floor ever becomes
unnecessary because the upstream pin moves, delete it rather than leaving it to rot.
