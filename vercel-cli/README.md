# drk-deploy

A command-line client that deploys **devresponsekit** — or one of its **satellites** — to Vercel:
project link, environment variables, Postgres, migrations, promotion and verification, in the one
order that is safe.

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

## Two targets

Every command reads one field — `target` in `.drk-deploy.json` — and behaves accordingly. **A
config with no `target` is the kit**, which is what every config written before satellites existed
looks like, so nothing about the kit path changed.

|                      | **kit** (devresponsekit)        | **satellite** (app-standalone / app-handoff / app-shared) |
| -------------------- | ------------------------------- | --------------------------------------------------------- |
| Role                 | SSO **issuer**                  | SSO **consumer**                                          |
| Signing key          | holds `SSO_HANDOFF_PRIVATE_KEY` | holds **none** — refused                                  |
| `SSO_HANDOFF_ISSUER` | itself                          | **the kit**                                               |
| Database schema      | owns it, migrates it            | usually the kit's — migrations **fail closed**            |
| Session              | its own                         | A/B their own; **C shares the kit's**                     |
| Health check         | serves + publishes a key        | serves + reaches its DB + **refuses a bad token**         |

The same variable meaning the opposite thing on the two targets is the whole reason this
distinction is recorded in the config rather than left to the operator to remember.

### Satellite options

| Option           | Auth model                                                      | Database     |
| ---------------- | --------------------------------------------------------------- | ------------ |
| `standalone` (A) | own session; signs in via an SSO handoff, keeps a local profile | own or kit's |
| `handoff` (B)    | own session; handoff, **no** local profile table                | own or kit's |
| `shared` (C)     | **no handoff** — shares the kit's database, secret and cookie   | the kit's    |

"Own or kit's" is a security decision as well as a deployment one. An A or B satellite on the kit's
database is **not contained**: a compromise of its server reaches the primary's auth tables, which
makes it security-equivalent to C. So is one on an "own" database that it reaches as the kit's
Postgres role: roles are cluster-wide, so a compromised satellite changes the database name in
its URL back to the kit's. "Own" has to mean its own role too, and on Neon one created with SQL:
a role made in the console joins `neon_superuser`, which writes every table in the project. The
same goes for one whose host sits under the kit's `COOKIE_DOMAIN`. The kit's database is also
this CLI's default, so see
[When A or B is actually contained](../docs/integration-satellite-apps.md#11-when-a-or-b-is-actually-contained)
before choosing it for anything but a first-party app.

---

## First deployment

### The kit

```cmd
drk-deploy login                     :: store a Vercel access token
drk-deploy init --project my-app --domain app.example.com
drk-deploy doctor                    :: check the toolchain before changing anything
drk-deploy db:provision              :: optional — create a marketplace Postgres
drk-deploy up --from-env .env.production
```

`--from-env` supplies the values that cannot be generated — principally `DATABASE_URL`. Anything
the CLI _can_ generate (signing keys, cron tokens) it generates.

### A satellite

```cmd
drk-deploy init --project app-standalone --domain app1.example.com ^
                --satellite standalone ^
                --app-root C:\my\repos\devresponseapps\app-standalone ^
                --issuer https://app.example.com
drk-deploy up --from-env .env.app1
```

`--issuer` is **the kit's** origin: the satellite fetches `${issuer}/api/sso/jwks.json` and
verifies handoffs against it. `init` refuses an issuer equal to the satellite's own origin,
because a deployment that names itself as issuer verifies against its own (empty) key set and
every handoff fails with what looks like the issuer's fault.

Option C additionally needs the shared cookie domain and the kit's session secret:

```cmd
drk-deploy init --project app-shared --domain app3.example.com ^
                --satellite shared ^
                --app-root C:\my\repos\devresponseapps\app-shared ^
                --issuer https://app.example.com ^
                --cookie-domain .example.com
:: BETTER_AUTH_SECRET must be the KIT's — it is never generated for Option C
set BETTER_AUTH_SECRET=<the kit's value>
drk-deploy up --from-env .env.app3
```

Re-running `init` on a satellite config keeps it a satellite. There is no flag that demotes one
back to the kit; edit or delete `.drk-deploy.json` if that is genuinely what you want.

One config file describes **one** deployment, so a fleet means one `vercel-cli` checkout per
deployment (or swapping `.drk-deploy.json`). Converting an existing **kit** config into a satellite
in place is the one transition that refuses to inherit anything: it demands an explicit `--project`
(and a `--domain`), and refuses a project id equal to the one already recorded. A satellite is
never the kit's Vercel project — if it were, `env:check` would read the KIT's environment, report
the issuer's real signing key under "must NOT be set on this satellite", and `env:prune` would
delete it, breaking handoff verification for the whole fleet.

---

## Commands

| Command        | What it does                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `login`        | Stores a Vercel token, after proving it works. Saved to your user profile, never the repo.                           |
| `init`         | Links this checkout to a Vercel project and records the target and its settings.                                     |
| `doctor`       | Checks Node, pnpm, the Vercel CLI, credentials and the project link. Changes nothing.                                |
| `status`       | Project, latest production deployment, and a live health probe.                                                      |
| `env:check`    | Reports what production is missing, has wrong, or must not have. Public values are read back. Exit 1 on a problem.   |
| `env:sync`     | Creates every variable this target needs, generating the secrets it may.                                             |
| `env:prune`    | Removes variables that must not exist here, including a satellite's stray signing key.                               |
| `db:provision` | Creates a marketplace Postgres store and connects it to the project. Refused unless this deployment owns a database. |
| `db:status`    | Shows the database variables wired into the project.                                                                 |
| `migrate`      | Applies the kit's migrations. Refused for a satellite that does not own its schema.                                  |
| `deploy`       | Migrate → build → promote → verify (no migrate step when the target does not own a schema).                          |
| `up`           | `env:sync` then `deploy`. The whole thing.                                                                           |

Every command accepts `--dry-run`, every command is safe to re-run, and every command reads the
recorded target first.

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
`BETTER_AUTH_SECRET` signs out every active user. A variable missing from some of the targets being
synced is written only to those, so `--target all` fills in Preview and Development without touching
the Production value, and without counting as a rotation.

**"Set" means set where the deployment reads it, and a public value is read back.** A variable
counts as present only when entries for every target being synced or deployed carry it (Production
for `env:check` and `deploy`). An entry scoped to Development, a git branch or a custom environment
does not count: a `DATABASE_URL` added with `vercel env add DATABASE_URL development` used to satisfy
the preflight of a Production build that cannot boot without it. Each public value (`BETTER_AUTH_URL`,
`SSO_HANDOFF_ISSUER`, the audience prefix and application id, `COOKIE_DOMAIN`, the `NEXT_PUBLIC_*`
values…) is then read back: a `plain` one comes with the listing and an `encrypted` one is decrypted
on request. It must pass the same rule the kit applies at boot. The origin and the SSO identity
(`BETTER_AUTH_URL`, `NEXT_PUBLIC_APP_URL`, `SSO_HANDOFF_ISSUER`, the audience prefix and application
id, and an Option C satellite's `COOKIE_DOMAIN`) must also equal what the recorded config derives, or
they are reported with the value expected and the value found. `NEXT_PUBLIC_APP_NAME` and
`NEXT_PUBLIC_PRODUCTION_HOST` are derived only as defaults, so a value you chose for them is left
alone, and `env:check` reports such a value as `readable, no rule` rather than `value checked`. A
public value stored `sensitive` is a problem on its own, because nothing can read it back: that is how
the kit's production `SSO_HANDOFF_ISSUER` sat at `httsp://…` for a week while every check was green
and every satellite handoff was refused. Secrets are checked for presence only and never fetched.
`env:check` and `env:sync` both apply these rules. `env:sync` refuses to continue while any entry it
would leave alone is wrong, including the Production entry of a key it is only filling in on Preview
or Development, because `up` runs no separate check after it. It also refuses a value supplied with
`--from-env` or the shell for the origin or the SSO identity when that value differs from the recorded
config and would be written to Production or Preview, because the next check would reject it. Drop
it to have the derived value written, or correct the config with `drk-deploy init`. (A localhost
origin written to Development alone is fine.) Each problem names its fix: remove the entry
(`vercel env rm <KEY> production`, or in the dashboard), then run `env:sync`, which re-creates it as
plain. `env:sync --force` is not the fix: it regenerates every secret it may.

**The deployment is verified, not assumed.** After promoting, the CLI probes `/api/health`,
`/api/health/ready` and a deliberately-wrong sign-in. A 401 on that last one means auth is alive;
a 500 means the build is up but broken. It also checks that the SSO issuer publishes a key — an
empty key set means no satellite can verify a handoff, which is invisible from the dashboard.

**A satellite is never handed signing material.** `SSO_HANDOFF_PRIVATE_KEY` (and its rotation
twin) are refused on a satellite, not merely omitted. A satellite ships the same
`/api/sso/launch` route the kit does, so a key set there turns a consumer into an issuer the whole
fleet trusts — and the point of the EdDSA + JWKS design is that compromising a satellite lets an
attacker forge no handoff token. `env:check` reports one, `env:sync` refuses to run while one is
present, `env:prune` removes it, and the post-deploy probe checks the running app publishes **no**
keys.

**A satellite that does not own its schema cannot migrate.** The satellites disable their own
`db:*` scripts for exactly this reason: they point at the primary's database and carry a truncated
migration set. `drk-deploy migrate` mirrors that refusal, with no `--force`. The escape is to
record in the config that this satellite genuinely has its own database (`init --own-database`),
after which `migrate` demands an explicit `--database-url` (or `SATELLITE_DIRECT_DATABASE_URL`)
rather than inheriting the kit's `PRODUCTION_DIRECT_DATABASE_URL` from your shell. `db:provision`
refuses on the same policy, and so does the advice `env:sync` prints when `DATABASE_URL` is
missing: on a shared database the answer is the kit's connection string, not a new store.

**A handoff satellite that is not contained is told so.** Forging no token is not containment. An A
or B satellite on the kit's database can write the primary's auth tables, and one whose host shares a
parent domain with the kit receives the kit's session cookie as soon as the kit sets
`COOKIE_DOMAIN` there (which Option C requires). Either way a compromise of the satellite is a
compromise of the kit. `init`, `doctor`, `env:check` and `deploy` (including `up`) print a warning
naming which of the two applies and linking the doc section. It is a warning, not a counted problem:
satellites on the kit's database are what this CLI deploys by default, and they keep deploying. The
CLI cannot read the kit's actual `COOKIE_DOMAIN` or the value of `DATABASE_URL`, so it goes by the
recorded `database` setting and by the parent domain this host shares with `--issuer` (or the host
itself, when the two differ only by port: cookies are not scoped by port). A recorded `own` gets no
database warning, so record it only when `DATABASE_URL` signs in as the satellite's own role, not
the kit's under another database name.

**An Option C secret is never generated.** Option C validates the kit's session cookie directly,
which works only when both hold the identical `BETTER_AUTH_SECRET`. Generating a fresh one would
not fail loudly — the app boots, serves, and passes every probe, while users bounce between signed
in and signed out. So it must be supplied, and the error says why. Conversely `COOKIE_DOMAIN` is
required for Option C (and validated against the deployment's own host) and refused for A and B,
where a parent-domain cookie would shadow the host cookie.

**A consumer is probed as a consumer.** A satellite publishes no keys, so asking it for one would
report failure forever. Its health is `/api/health`, `/api/health/ready`, and `/api/sso/consume`
answering **401** to a deliberately garbage token. A 500 there is the interesting failure: it means
the audience variables are missing, which otherwise stays invisible until the first real handoff.
It also probes the **issuer's** JWKS — the half a satellite cannot fix and cannot see from its own
endpoints: a kit publishing an empty key set means every handoff fails here, looking like a bad
signature. Note that the consume probe is audited by the app, so each `status` or `deploy` appends
one `sso.consume.failure` row (on a shared database, to the primary's audit table). The probes send
a `drk-deploy-probe` User-Agent so those rows are identifiable rather than alarming.

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

### A satellite's contract

Same six required names, three of which mean something different:

| Variable                      | On a satellite                                                         |
| ----------------------------- | ---------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`          | A/B: generated, its own. **C: the KIT's, supplied — never generated.** |
| `BETTER_AUTH_URL`             | derived — this app's own origin                                        |
| `DATABASE_URL`                | supplied. C: **the kit's** database                                    |
| `SSO_HANDOFF_ISSUER`          | derived — **the kit's** origin, whose JWKS it verifies against         |
| `SSO_HANDOFF_AUDIENCE_PREFIX` | derived — must match the kit's exactly                                 |
| `SSO_HANDOFF_APPLICATION_ID`  | derived — this satellite's own id, which binds the nonce burn          |

Plus `COOKIE_DOMAIN` (required for Option C only) and `NEXT_PUBLIC_APP_URL`. Two more are
deliberately quieter than the kit's:

- `DB_SCHEMA` is **recommended whenever the deployment runs on the kit's database** — which is the
  default for every option, not just C. An A or B satellite on the primary's Postgres reads the
  primary's tables, so a schema mismatch is an empty read, not an error. It is also not a boundary:
  `DB_SCHEMA` only sets the `search_path`, and a satellite on the kit's database is not contained
  whatever its value. `DATABASE_URL` says the same thing: on a shared database it is **the kit's**
  connection string, and `db:provision` is refused rather than handing the app an empty database
  that `migrate` would then refuse to fill.
- `CRON_SECRET` is **optional and never generated** for a satellite on the kit's database. No
  satellite ships a `crons` entry — all three `vercel.json` files carry only `$schema` and
  `regions`; the kit's is the one with the schedule. `app_outbox` has no originating-app column, so
  a drain running on a satellite would claim the **primary's** rows, send its mail through this
  app's provider credentials and read `delivery_payload` — the unredacted copy carrying live
  password-reset and invitation tokens. 401 forever is the correct state, so the CLI leaves it
  that way. A satellite that owns its own database gets the token, with the note that it must
  schedule the route itself.
- `ADMIN_TRUSTED_ORIGINS` is optional, and is **not** a place to put the kit's origin. It gates
  unsafe methods only; the handoff is a GET redirect and the confirm POST is same-origin, so a
  cross-origin request from the kit never arrives — listing it only widens the CSRF allow-list.

Refused outright on a satellite: `SSO_HANDOFF_PRIVATE_KEY`, `SSO_HANDOFF_PREVIOUS_PRIVATE_KEY`,
`SSO_HANDOFF_KID`, `SSO_HANDOFF_PREVIOUS_KID`, `SSO_ALLOWED_ORIGIN_SUFFIXES` — all issuer-only —
and `COOKIE_DOMAIN` on Options A and B, where only the Option C app reads it at all: it is inert
there, and an inert variable that reads like a shared-session setting is how an operator comes to
believe a control is enforced where it is not. `env:sync` refuses to run while any of them is set
on the project, in a `--from-env` file, **or exported in your shell**.

The retired `SSO_HANDOFF_JWT_SECRET` is deliberately absent from all of this. The handoff is EdDSA
signed and JWKS verified; a shared symmetric secret would have let every consumer mint tokens,
which is the property the current design exists to remove. If an old deployment still carries one,
delete it — nothing reads it.

---

## Upgrading

### F-46: public values must be readable

`env:check`, and therefore `deploy`, and `env:sync`, and therefore `up`, now fail on a public value
stored as a Vercel **sensitive** variable. Before F-46 they checked only that a key existed. A project
whose public values were typed into the dashboard as Sensitive will fail its first check after the
upgrade. That is intended: those are the values nothing could verify. No flag exempts a key. `deploy
--yes` still deploys past every `env:check` problem, as it always has, and `up` has no such escape.
The one-time migration:

1. Run `drk-deploy env:check`. Each `WRONG` key prints its own commands.
2. Remove every flagged entry, not only the first one: `env:sync` refuses to run while any flagged
   key is left. Use `vercel env rm <KEY> production` for each (add `preview` when the entry covers
   it), or delete them in the dashboard.
3. Run `drk-deploy env:sync`. It re-creates each derived value (`BETTER_AUTH_URL`,
   `SSO_HANDOFF_ISSUER`, `SSO_HANDOFF_AUDIENCE_PREFIX`, `SSO_HANDOFF_APPLICATION_ID`, `COOKIE_DOMAIN`,
   `NEXT_PUBLIC_*`) as plain from the recorded config. For a supplied one, such as
   `SSO_ALLOWED_ORIGIN_SUFFIXES`, `EMAIL_FROM` or `DB_SCHEMA`, pass the value with `--from-env <file>`
   or the shell. Pass `NEXT_PUBLIC_APP_NAME` the same way to keep a product name that differs from
   the recorded `--app-name`, or the recorded one replaces it.
4. Redeploy. An environment change takes effect only on the next deployment.

Check the values the recorded config derives before step 2: `env:sync` writes those, so a wrong
`--domain`, `--issuer` or application id in `.drk-deploy.json` would replace a correct value.
Passing the correct value with `--from-env` does not override the config: for the origin and the SSO
identity, `env:sync` refuses a supplied value that differs from it. A
sensitive value cannot be read back to compare, so confirm it where it can be observed, for example
the `iss` and `aud` of a freshly minted handoff token. Re-run `drk-deploy init` first if the config is
wrong. Secrets stay `sensitive` (or `encrypted`). They are never read, and nothing here asks you to
change them.

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

It is refused for a deployment that does not own a database, on the same policy that refuses
`migrate`: connecting a store injects a fresh `DATABASE_URL`, and for a satellite on the kit's
Postgres that silently points the consumer at an **empty** database. It boots, `/api/health/ready`
answers 200 because the connection itself works, and every session lookup and handoff nonce burn
then misses. The answer there is the kit's connection string, not a new store.

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

Files: `src/lib/target.ts` decides WHAT is being deployed (kit or satellite) and holds the pure
rules — the migration policy, the config sanity checks — so they can be asserted directly.
`src/lib/env-spec.ts` is the environment contract for both targets, and the one to edit when the
kit's `src/lib/env.ts` or a satellite's changes. `src/lib/env-presence.ts` decides what counts as set
for a target and what is wrong with a stored value; every command that asks goes through it.
`src/lib/vercel-client.ts` wraps `@vercel/sdk`. `src/commands/` is one file per command group.
`test/env-presence.test.ts` runs `env:check`, `env:sync` and the `deploy` preflight for real against a
fake Vercel API (`fetch` is replaced), so those tests never reach Vercel either.

The test suite is the only thing standing between a refactor and a silently wrong deployment.
Everything worth relying on is written as a pure function for that reason: keep it that way when you
add a rule. The part that cannot be pure, the release ORDER, goes through a runner instead: `deploy`
and `up` reach every step that touches Vercel, a database or a subprocess (`envSync`, `envCheck`,
`migrate`, `link`, `pull`, `build`, `promote`, `verify`) through `ReleaseRunner` in
`src/commands/release.ts`. `test/release.test.ts` passes a recording fake and asserts that migrations
run before the promotion and that nothing runs after a failed step, so a new step belongs in the
runner. The fake stands in for every step, so the tests never reach Vercel or a database.
`drk-deploy migrate` calls `migrate` directly, not through `deploy`, so the same file also calls the
real `migrate` and asserts both of its refusals: a satellite on the kit's database, and a satellite
that would inherit the kit's `PRODUCTION_DIRECT_DATABASE_URL` from the shell. Each refuses before
anything connects or spawns.

The required keys in `src/lib/env-spec.ts` are checked against the kit's own schema by the kit's
suite, not this one (`tests/unit/drk-deploy-required-keys.test.ts`, which can import both): a key
`src/lib/env.ts` starts requiring fails the kit's required checks until the spec requires it too.

### CI

The kit's CI runs this package's checks in a job of its own, **`Deploy CLI (drk-deploy)`** in
`.github/workflows/ci.yml` (F-45): `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`
(which builds first) and `pnpm format:check`, on every pull request and every push to `main`. It is
deliberately not path-filtered, because a required check that a path filter skips never reports and
blocks every merge. Before F-45 nothing in CI built this package, so a dependency bump that broke it
merged green.

**Operator step:** add `Deploy CLI (drk-deploy)` to the required status checks in `main`'s branch
protection. That is a repository setting no workflow can make; until it is set, a red run is visible
but does not block a merge. The advisory audit of this lockfile is not repeated in that job: it runs
in the required `Dependency audit` check ([below](#dependency-override-floors)).

---

## Dependency override floors

Everything this CLI ships is transitive: the only direct dependencies are `@vercel/sdk`,
`vercel` and `commander`. When an advisory lands inside that tree there is usually nothing to
upgrade — `vercel` is already on its latest version and pins the vulnerable package itself —
so the fix is a floor in `pnpm.overrides`, not a mute. The floors below took this package from
50 advisories (1 critical, 20 high) to none.

| Override              | Floor     | Advisory / reason                                                                                                                                                                                                           |
| --------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tar@7`               | `^7.5.21` | Nine advisories, one **critical**. Reached through the CLI's archive handling.                                                                                                                                              |
| `undici@5` → `undici` | `^6.28.0` | **A deliberate major.** Most undici advisories affecting the installed 5.x line are only patched in 6.x, so there is no in-major fix; `@vercel/node` pins 5.28.4. See the note below.                                       |
| `js-yaml@4`           | `^4.3.2`  | Four advisories, worst high.                                                                                                                                                                                                |
| `minimatch@10`        | `^10.2.3` | Three advisories, high. The 3.x copy in the tree is unaffected and deliberately untouched.                                                                                                                                  |
| `path-to-regexp@8`    | `^8.4.0`  | Three advisories.                                                                                                                                                                                                           |
| `path-to-regexp@6`    | `^6.3.0`  | GHSA-9wv6-86v2-598j (high, backtracking regex). `@vercel/node` pulls **both** 6.1.0 and 6.3.0; only the former is vulnerable. Note `pnpm audit` does **not** report this one — GitHub's advisory database does. Check both. |
| `smol-toml@1`         | `^1.7.1`  | Two advisories, worst high.                                                                                                                                                                                                 |
| `ajv@8`               | `^8.18.0` | One moderate.                                                                                                                                                                                                               |
| `@tootallnate/once@2` | `^2.0.1`  | One low.                                                                                                                                                                                                                    |

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

CI audits this lockfile too. The kit's `Dependency audit` workflow
(`.github/workflows/dependency-audit.yml`, a required check) runs
`pnpm --dir vercel-cli audit --audit-level high` on every pull request and weekly. Its weekly
`Dependabot alerts` job reads GitHub's alerts for every manifest, including this one, which
catches what `pnpm audit` misses (the `path-to-regexp@6` row above). Before F-28 neither check
looked here, so this tree's advisories surfaced only as alerts in the Security tab.

This lockfile has its own advisory allowlist: `pnpm --dir vercel-cli audit` reads
`pnpm.auditConfig.ignoreGhsas` from this package's `package.json` and never the kit's root
list, so muting a GHSA at the root does not mute it here. The list is empty. Prefer a floor
above. A mute goes here only under the deploy-CLI rule in
[SECURITY.md → Dependency advisory allowlist](../SECURITY.md#dependency-advisory-allowlist),
with a row there that names `vercel-cli/pnpm-lock.yaml` and a review-by date. The kit's
`tests/unit/dependency-governance.test.ts` fails on a mute without that row.
