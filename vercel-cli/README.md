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

Every command reads one field — `target` in the deployment's config file (`.drk-deploy.json`
unless `--config` names another) — and behaves accordingly. **A config with no `target` is the
kit**, which is what every config written before satellites existed looks like, so nothing about
the kit path changed.

|                      | **kit** (devresponsekit)        | **satellite** (app-standalone / app-handoff / app-shared)  |
| -------------------- | ------------------------------- | ---------------------------------------------------------- |
| Role                 | SSO **issuer**                  | SSO **consumer**                                           |
| Signing key          | holds `SSO_HANDOFF_PRIVATE_KEY` | holds **none** — refused                                   |
| `SSO_HANDOFF_ISSUER` | itself                          | **the kit**                                                |
| Database schema      | owns it, migrates it            | usually the kit's — migrations **fail closed**             |
| Session              | its own                         | A/B their own; **C shares the kit's**                      |
| Health check         | serves + publishes its key      | serves + reaches its DB + **refuses a bad token** + no key |

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

`--from-env` supplies the values that cannot be generated. `DATABASE_URL`, the runtime (usually
pooled) connection string, is written to the project by `env:sync`. `PRODUCTION_DIRECT_DATABASE_URL`,
the DIRECT connection string of the same database, is what migrations run against. It is read
locally and never written to Vercel. `DATABASE_URL` is never used for migrations, from the file or
the shell (F-47). Anything the CLI _can_ generate (signing keys, cron tokens) it generates.

A team and a personal account are set up the same way. Pass `--team <team_id>` only for a project
a team owns. Either way `init` reads the project's owner from the project itself (its `accountId`:
the team's id, or the personal account's own id) and records it as `orgId`. The Vercel CLI takes its
project from the environment only as the pair `VERCEL_ORG_ID` + `VERCEL_PROJECT_ID`, and refuses one
without the other (F-48).

### A satellite

Each deployment has its own config file. The kit keeps the default `.drk-deploy.json`, and each
satellite gets one named with `--config` (or `DRK_DEPLOY_CONFIG`), so configuring one never
rewrites another's:

```cmd
drk-deploy --config .drk-deploy.app-standalone.json init ^
                --project app-standalone --domain app1.example.com ^
                --application-id standalone ^
                --satellite standalone ^
                --app-root C:\my\repos\devresponseapps\app-standalone ^
                --issuer https://app.example.com
drk-deploy --config .drk-deploy.app-standalone.json up --from-env .env.app1
```

`--config` goes before or after the command, and it wins over `DRK_DEPLOY_CONFIG`. A relative path
names a file **beside the CLI** (in `vercel-cli/`, next to `.drk-deploy.json`), whatever the current
directory, so the same command finds the same file from the kit's root or anywhere else, and
`vercel-cli/.gitignore` keeps it out of git (it ignores `.drk-deploy*.json`). An absolute path is
used as given, and keeping that file out of git is up to you.
`set DRK_DEPLOY_CONFIG=.drk-deploy.app-standalone.json` once makes every command in that shell act
on that deployment. `doctor`, `init` and `deploy` print the file they used, and every command a
message tells you to run on this deployment carries the same `--config`. (One that is about the
kit's own config, such as the kit's `env:sync` a satellite's probe asks for, is printed bare.)

`--issuer` is **the kit's** origin: the satellite fetches `${issuer}/api/sso/jwks.json` and
verifies handoffs against it. `init` refuses an issuer equal to the satellite's own origin,
because a deployment that names itself as issuer verifies against its own (empty) key set and
every handoff fails with what looks like the issuer's fault.

Option C additionally needs the shared cookie domain and the kit's session secret:

```cmd
drk-deploy --config .drk-deploy.app-shared.json init ^
                --project app-shared --domain app3.example.com ^
                --application-id shared ^
                --satellite shared ^
                --app-root C:\my\repos\devresponseapps\app-shared ^
                --issuer https://app.example.com ^
                --cookie-domain .example.com
:: BETTER_AUTH_SECRET must be the KIT's — it is never generated for Option C
set BETTER_AUTH_SECRET=<the kit's value>
drk-deploy --config .drk-deploy.app-shared.json up --from-env .env.app3
```

Re-running `init` on a satellite config keeps it a satellite. There is no flag that demotes one
back to the kit; edit or delete the config file if that is genuinely what you want.

One config file describes **one** deployment (F-50). Re-running `init` for the **same** deployment
keeps every recorded value you do not pass again, which is what makes `init --yes` a safe refresh.
The one exception is a new `--project`: the recorded domain belonged to the old project, so the
domain comes from `--domain` or the new project, as on a first `init`. A run that names a
**different** deployment keeps none of the recorded deployment's own values: a new `--satellite`
option, a new `--app-root`, or a kit config turned into a satellite. Such a run is refused until it
names the whole deployment: `--project`, `--domain`, `--application-id`, `--satellite`, `--app-root`,
and under `--yes` `--kit-database` or `--own-database` (Option C needs neither). Only the fleet's
settings carry over: the `--issuer`, the audience prefix, the team and the kit checkout. Before F-50
a new option or app folder kept everything else, so app-handoff configured over app-standalone's
file was built into app-standalone's project under its domain and application id, and `up` replaced
app-standalone's production with it. A separate file per deployment (above) avoids the question
entirely.

A checkout that moved (a re-clone of the satellites' repository, say) is a new `--app-root` too,
because another folder is far more often another app. `deploy` stops on a checkout that no longer
exists and prints the `init` that names the deployment in full, every value taken from the file,
with only the path left to fill in; a bare `init --app-root <new path>` is refused and, while the
recorded checkout is gone, offers the same command with the path filled in. Naming the recorded
project keeps the recorded product name (`--app-name`). A value the file does not record at all,
such as a satellite block with no checkout, is filled in rather than changed.

A satellite is never the kit's Vercel project, and nothing lets a satellite config act on it
(F-50). The config names the kit only by its origin, so the kit's project is recognised by what it
serves: a project whose production aliases include the issuer's host (or whose readable
`BETTER_AUTH_URL` is the issuer's origin) is the issuer's. `init` refuses to save such a config, and
`deploy`, `up`, `migrate`, `env:sync`, `env:check`, `env:prune` and `db:provision` refuse to act on
one, with exit code 2 and nothing changed. `doctor` counts it and `status` warns. No flag overrides
it: `deploy --yes` and `--skip-checks` skip the environment preflight, and this check is not part of
it. Before F-50 such a config built the satellite and promoted it over the primary, and `env:check`
reported the issuer's real signing key under "must NOT be set on this satellite" and pointed at
`env:prune`, which deleted it and broke handoff verification for the whole fleet.

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
| `env:prune`    | Removes variables that must not exist here, including a satellite's stray signing key. Refuses the kit's project.    |
| `db:provision` | Creates a marketplace Postgres store and connects it to the project. Refused unless this deployment owns a database. |
| `db:status`    | Shows the database variables wired into the project.                                                                 |
| `migrate`      | Applies the kit's migrations to production, checked first. Refused for a satellite that does not own its schema.     |
| `deploy`       | Pull → migrate (checked) → build → promote → verify (no migrate step when the target does not own a schema).         |
| `up`           | `env:sync` then `deploy`. The whole thing.                                                                           |

Every command accepts `--dry-run`, every command is safe to re-run, and every command reads the
recorded target first. Every command also takes `--config <file>`, the deployment's config file
(default: `DRK_DEPLOY_CONFIG`, else `.drk-deploy.json`; a relative path is beside the CLI).

---

## What it does about the things that go wrong

**Migrations run before promotion.** `deploy` applies migrations first and promotes only if they
succeed. If a migration fails, the currently-live build keeps serving against the schema it
understands, and nothing is promoted. This is the ordering the repo's own deploy workflow
documents, and the reason it is documented is that the reverse has caused outages.

**Migrations run against production, checked rather than assumed (F-47).** The migration URL is
named explicitly: `--database-url`, or `PRODUCTION_DIRECT_DATABASE_URL` in the shell or the
`--from-env` file (a satellite that owns its database: `SATELLITE_DIRECT_DATABASE_URL`). The shell
wins over the file, and an empty shell value counts as unset, as it does for `env:sync`: a CI step
exporting a secret that is not defined exports an empty string. A shell's
`DATABASE_URL` or `DIRECT_DATABASE_URL` is never used, because on the machine a deploy runs from it
is usually a local database: `up` used to migrate that, report success, and promote a build that
expected the new schema over a production without it. Before migrating, `deploy`, `up` and
`migrate` run the read-only `vercel pull --environment=production` and compare the URL with what
production reads:

- **The database.** Host, port (5432 when none is given) and database name must equal those of
  production's `DATABASE_URL` or `DATABASE_URL_UNPOOLED`. Neon's `-pooler` host suffix is ignored,
  so the direct URL matches the pooled one. On Supabase's shared pooler (`*.pooler.supabase.com`)
  every project in the region has the same host and the same `postgres` database, so the project in
  the username (`postgres.<ref>`) is compared instead of the port. A mismatch is refused before
  anything migrates, and there is no override: point the URL at production's direct endpoint. If
  production's pooled URL is not the direct one with `-pooler` removed (another host or another
  port: Supabase, PgBouncer), store the direct URL on the project as `DATABASE_URL_UNPOOLED`,
  encrypted, so it can be matched. A migration URL whose query re-points the connection (`host`,
  `hostaddr`, `port`, `dbname`, `database` or `user`) is refused outright, because what is checked
  would not be what is migrated. The migration runner is handed the URL and the schema with the
  shell's `PGHOST`, `PGHOSTADDR`, `PGPORT`, `PGDATABASE` and `PGUSER` removed, for the same reason:
  `pg` fills in any part the URL leaves out from those.
- **The schema.** It defaults to production's `DB_SCHEMA`, or `auth` when production sets none.
  Before F-47 it was always `auth`, so a production on `tenant_a` was migrated in the wrong schema.
  A `--schema` that production does not read is refused unless `--force-schema`.
- **Values that cannot be read.** A variable stored `sensitive` comes back from `vercel pull` as
  `[SENSITIVE]`, so there is nothing to compare. That is refused too, unless
  `--allow-unverified-target`, which prints what it skipped. It never covers a mismatch. An
  unreadable `DB_SCHEMA` is never guessed: pass `--schema` with it.

The pulled file, `.vercel/.env.production.local`, holds production's secrets in plain text. It is
deleted before the pull (`vercel pull` keeps a stale copy's local values, so an old file could vouch
for the wrong database) and again when the run ends, successful or not. The kit's `.gitignore`
ignores `.vercel/` as well. A `--dry-run` pulls nothing, so it checks nothing, and says so.

**`vercel` acts on the recorded project, and only that one (F-48).** Every `vercel link`, `pull`,
`build` and `deploy` is handed `VERCEL_ORG_ID` together with `VERCEL_PROJECT_ID`, both from
`.drk-deploy.json`, or neither. The Vercel CLI exits 1 on one without the other, and this CLI used to
set the project id without the owner for a personal account, so every deploy from one failed at
`vercel pull`. With neither set, `vercel` reads the checkout's `.vercel/project.json`, so that file is
checked against the config before anything runs and again after `vercel link` writes it. A checkout
linked to another project is refused, never re-linked over: the two disagree because one of them is
wrong, and a satellite checkout linked to the kit's project would otherwise build and promote into
it. Delete the file if the config is right, or re-run `init` if the checkout is. The shell's
`VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` (and the legacy `NOW_ORG_ID` / `NOW_PROJECT_ID`, in any
casing) are never passed to `vercel`. One that names another project or owner than the config is
refused before anything runs, `env:sync` included, because whoever exported it meant that project.
Only a name `vercel` would read is checked: any casing on Windows, where a variable's name has none,
and the exact name elsewhere. `doctor` reports the same refusal.

**A release is a clean, pushed commit, and each run names it (F-49).** `deploy`, `up` and `migrate`
used to release whatever the checkout held, and the kit's migration runner ledgers every file it
applies under a checksum. An uncommitted `0007-foo.sql` run from a feature branch stayed applied in
production, and once review changed it, every later migrate against production aborted on the
checksum mismatch until someone rewrote the ledger by hand. Now, before anything writes (`env:sync`,
`vercel link`, the pull, a migration), each command reads the checkouts it releases from with
read-only `git` and refuses the run unless:

- **The tree is clean.** `git status --porcelain` is empty, untracked files included, whatever
  `status.showUntrackedFiles` says. No flag overrides this. Commit and push, or set the changes aside
  with `git stash --include-untracked`. One change is set aside instead, and named on its own
  line: a `next-env.d.ts` modified in the working tree, in any folder. `next build` rewrites that
  file on every run (the kit commits the `next dev` form, and a build writes its own), and that
  includes the build `deploy` runs. Next regenerates it from the app's config before anything reads
  it, and it emits no code. A staged, deleted or untracked `next-env.d.ts` still counts.
- **HEAD is pushed.** A remote-tracking branch points at it, so review can see exactly what ran.
- **For `deploy` and `up`, HEAD is origin's default branch.** That is `origin/HEAD` as a clone
  records it, or `origin/main` when there is none (a CI checkout). `--allow-ref <ref>` names another
  pushed ref to promote, such as `origin/hotfix`. HEAD must then be that ref, and the first two rules
  still apply.
- **For a satellite that owns its database, the kit checkout is at the kit's default branch.**
  `deploy`, `up` and `migrate` all hold it there, and no flag moves it: `--allow-ref` names the
  satellite's ref, never the kit's. The migrations it applies are ledgered in the satellite's
  production under their checksums, and no document describes migrating that database ahead of a
  kit merge.

The kit's own `migrate` does not need the default branch.
[docs/deployment.md §1.1](../docs/deployment.md#11-the-live-path-vercel-git-integration--hand-applied-migrations)
has the kit's production migrated from the open pull request's branch before it merges.
`drk-deploy migrate` run from that branch, clean and pushed, does that with the target checked.
Nothing is fetched, because a fetch writes refs: "pushed" and "origin/main" are the remote-tracking
refs as the checkout last fetched them, and the output says so. Run `git fetch` first if the branch
moved elsewhere.

The kit checkout is read whenever the run migrates (the migrations are always the kit's) or deploys
the kit. A satellite's app folder is read when it is the one built. A satellite on the kit's
database never reads the kit checkout. The shell's `GIT_DIR`, `GIT_WORK_TREE` and the other variables
that point `git` at another repository are removed first, in any casing. Each run prints the commit,
its branch, the tree's state and where it is pushed before anything writes, and prints them again next
to the database it migrates. That line is the record of what ran: the migration ledger has no column
for it, and `vercel deploy --prebuilt` records the promoted build's own commit already. After the
build, `deploy` and `up` put the checkout's `next-env.d.ts` back byte for byte, whether or not the
build succeeded, so a run leaves the checkout as it found it. A `--dry-run` reads and reports the same
and refuses nothing. If it cannot read the project's git connection, it says so and goes on. A real
run stops. `doctor` counts as a problem a dirty, unpushed or non-git checkout, and a satellite's kit
checkout that is off the kit's default branch. It notes a deployed checkout's HEAD
that is not origin's default branch without counting it, because the kit's `migrate` allows one.

**Vercel's git integration is a second deployer, and a run that migrates refuses it (F-49).** While
the project's git integration builds and promotes every push to its production branch, `deploy` and
`up` cannot keep their order: a merge goes live ahead of its migration whatever runs afterwards.
Before anything writes, they read the project's git connection from the Vercel API. A run that would
migrate is refused while production auto-deploys. It counts as off only where the CLI can tell: no
repository connected, `"git": { "deploymentEnabled": false }` (or `{ "<production branch>": false }`)
in the checkout's `vercel.json`, or an Ignored Build Step of exactly `exit 0`. Any other Ignored
Build Step is a program the CLI cannot run, so it is named in the refusal and counts as on.
`--allow-git-integration-race` deploys anyway, with a warning. A run with no migrate step
(`--skip-migrations`, or a satellite on the kit's database) has no order to lose, so it is only
warned. `migrate` never asks, because it promotes nothing. The kit's own production is deployed by
the git integration today (docs/deployment.md §1.1), so `deploy` and `up` refuse to migrate it until
auto-deploy is off or the flag is passed.

**A pooled connection string is refused.** Migrations need the _direct_ endpoint: DDL and the
advisory lock the migration runner takes do not survive a transaction pooler, and the failure is
silent rather than loud. Neon's `-pooler` host, a `.pooler.` host (Supabase), port 6543 and
`pgbouncer=true` are all refused. Pass `--allow-pooled` only if you know why you are doing it.

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
a 500 means the build is up but broken. It also checks that the SSO issuer publishes a key: an
empty key set means no satellite can verify a handoff, which is invisible from the dashboard. When
production sets `SSO_HANDOFF_PRIVATE_KEY` (read from the variables `vercel pull` wrote for this
build), an empty key set, or none served, fails the probe. When production sets no key it is a
warning, because a kit that runs no SSO publishes an empty set by design (F-51).

**A build that fails its probe is rolled back, or the rollback is named (F-51).** Before anything
writes, `deploy` and `up` read which deployment the production origin serves (its alias, the host
the probe requests, not the project's latest deployment) and print it under "Rollback target". A
first deployment has none. If the probe then fails:

- With `--rollback-on-fail`, which is the default under `--yes`, the CLI runs
  `vercel promote <that deployment> --scope=<owner>` and probes again. It uses `promote` rather than
  `vercel rollback` because an Instant Rollback turns off Vercel's automatic assignment of production
  domains. The next release would then deploy without going live, and its probe would report the
  rolled-back build healthy.
- Without it, or with `--no-rollback-on-fail`, the build stays live and the error prints that exact
  command with the recorded deployment filled in. Run that command. Re-running the release with
  `--rollback-on-fail` does not restore it: the new run records the broken build as the one serving,
  promotes it back, and reports an environment problem.

Rolling back the app after a migration is safe: migrations are forward-only, and the deployment it
restores was serving against the migrated schema from the migration to the promotion. Nothing in
the database is reverted.

| Exit | Meaning                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------- |
| 0    | Healthy.                                                                                                            |
| 3    | Not healthy, and still live: no rollback ran (none asked for, or production served nothing before this run).        |
| 4    | Not healthy, rolled back: the previous deployment serves production again and passes the probe. The release failed. |
| 5    | Not healthy, and the rollback failed, or the deployment it restored fails the probe too. Production needs a person. |

A real run that cannot read the serving deployment stops before anything writes, as it does when it
cannot read the project. A dry run says so and prints the command an unhealthy probe would run or
print.

**A satellite is never handed signing material.** `SSO_HANDOFF_PRIVATE_KEY` (and its rotation
twin) are refused on a satellite, not merely omitted. A satellite ships the same
`/api/sso/launch` route the kit does, so a key set there signs handoff tokens. Consumers verify
against the kit's published keys, so tokens signed with a key of the satellite's own are refused.
The realistic way a key gets there, though, is an environment copied from the kit's. With the kit's
own key the satellite signs tokens every consumer accepts, and the kit's private key sits on one
more deployment. The point of the EdDSA + JWKS design is that compromising a satellite lets an
attacker forge no handoff token. `env:check` reports one, `env:sync` refuses to run while one is
present, `env:prune` removes it, and the post-deploy probe **fails** when the running app publishes
any key (F-51; it used to print a note and exit 0, even after `deploy --yes` or `--skip-checks` had
skipped the preflight). The probe compares the published public key with the kit's and says which
case it is. When it is the kit's own key, rotate the kit's key as well, with no previous-key
overlap. `env:check`, `env:sync` and `env:prune` first refuse a project that serves the kit's origin
(and `deploy` does before it gets as far as the probe), and every hint that points at `env:prune`
names the project it would act on, so none of them can send anyone to delete the kit's own key
(F-50).

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
report failure forever. Its health is `/api/health`, `/api/health/ready`, `/api/sso/consume`
answering **401** to a deliberately garbage token, and a JWKS with **no** keys (above). A 500 from
the consume route is the interesting failure: it means
the audience variables are missing, which otherwise stays invisible until the first real handoff.
It also probes the **issuer's** JWKS — the half a satellite cannot fix and cannot see from its own
endpoints: a kit publishing an empty key set means every handoff fails here, looking like a bad
signature. That is reported and never fails the satellite's probe: rolling the satellite back would
not fix the kit. Note that the consume probe is audited by the app, so each `status` or `deploy`
appends one `sso.consume.failure` row (on a shared database, to the primary's audit table). The
probes send a `drk-deploy-probe` User-Agent so those rows are identifiable rather than alarming.

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

### F-51: a failed probe is rolled back, or named

1. **`deploy --yes` and `up --yes` now roll back a build that fails its probe.** They run
   `vercel promote` on the deployment production served before the run and probe again. They exit 4
   when that restores a healthy production and 5 when it does not, where they used to exit 3 and
   leave the broken build live. Pass `--no-rollback-on-fail` to keep the old behaviour. Without
   `--yes`, pass `--rollback-on-fail` to get the new one. Exit 3 still means "not healthy, still
   live", and its message now carries the `vercel promote` command that would roll it back.
2. **A satellite that publishes a signing key now fails its probe.** It used to exit 0 with a
   warning. Remove the key with `env:prune` and redeploy. If the probe says it is the kit's own key,
   rotate the kit's key as well.
3. **The kit fails its probe when production sets `SSO_HANDOFF_PRIVATE_KEY` but the build publishes
   no key**, or serves no key set. A kit whose production sets no key is unaffected: an empty key set
   there is still only a warning.
4. **`deploy` and `up` make one more read-only API call** before anything writes: the alias of the
   production origin (`GET /v4/aliases/<host>`). If it cannot be read, a real run stops with
   nothing changed, as it does when the project cannot be read.

### F-50: one config file per deployment, and never the kit's project

Nothing changes for a config that already describes one deployment. Three things to expect:

1. **Stop restoring the kit's config before each satellite's `init`.** Give each satellite its own
   file instead: `drk-deploy --config .drk-deploy.<name>.json init ...` once, then the same
   `--config` (or `DRK_DEPLOY_CONFIG`) on every later command for it. The kit keeps
   `.drk-deploy.json`. To split a fleet that shares one file today, copy the file to the
   satellite's name beside it in `vercel-cli/` (a relative `--config` is read from there, whatever
   the current directory), then run `drk-deploy --config <that file> init --yes` to check it.
2. **`init` that names another app or option is refused until it names the whole deployment.**
   Pass `--project`, `--domain`, `--application-id`, `--satellite`, `--app-root` and, with `--yes`,
   `--kit-database` or `--own-database`. The refusal lists what is missing. A moved or re-cloned
   checkout counts as another app: `deploy` prints the full `init` for it, filled in from the file.
   A re-run for the same deployment is unchanged, except that a new `--project` no longer keeps the
   old project's domain.
3. **A satellite config whose project serves the kit's origin is refused everywhere** (exit code 2),
   by `init`, `deploy`, `up`, `migrate`, `env:sync`, `env:check`, `env:prune` and `db:provision`,
   with no override. Run `drk-deploy doctor` once per config: it counts the problem as
   `vercel project wrong`. Point the config at the satellite's own project with
   `init --project <its project> --domain <its host> --application-id <its id>` and the config's own
   `--config`, as the refusal prints it (bare, it would re-point the kit's default file). `deploy` and `up`
   now read the project once before anything writes, as they already did for F-49. A satellite's
   `migrate`, `env:sync`, `env:check`, `env:prune` and `db:provision` make one more read-only API call.

### F-49: only a clean, pushed commit is released

`deploy`, `up` and `migrate` now refuse a checkout with uncommitted or untracked changes, or whose
HEAD is not pushed ([above](#what-it-does-about-the-things-that-go-wrong)). Four things to expect
on the first run:

1. **Files that tools write into the checkout count.** A file that is neither committed nor
   ignored stops the run, for example the `AGENTS.md` block `next dev` re-adds, or a report left at
   the repository root. Commit it, ignore it, or move it out. The exception is `next-env.d.ts`
   modified in the working tree. `next build` flips it from the committed `next dev` form
   (`./.next/dev/types/…`) to its own (`./.next/types/…`) every time it runs, so it is set aside and
   named rather than refused. Committing the build form only flips it back the next time `next dev`
   runs. To clear it, run `git checkout -- next-env.d.ts`. The build `deploy` and `up` run puts it
   back by itself.
2. **`deploy` and `up` from anything but origin's default branch need `--allow-ref`.** To migrate
   the kit's production from a pull request's branch before it merges, run `drk-deploy migrate` from
   that branch instead. It needs the branch pushed, not merged.
3. **A satellite that owns its database needs the kit checkout at the kit's default branch.** That
   holds for `deploy`, `up` and `migrate`, with no flag. Merge the kit's migration first, pull the kit
   checkout, then migrate or deploy the satellite.
4. **A project that Vercel deploys on every push refuses `deploy` and `up` when they would migrate.**
   The kit's production is one. Keep migrating from the pull request's branch with
   `drk-deploy migrate` and let the git integration promote the merge, as docs/deployment.md §1.1
   describes, or turn production auto-deploy off (§1.2), or pass `--allow-git-integration-race`.

### F-48: the project's owner is recorded

A config that an earlier `init` wrote for a personal account has no `orgId`. It still deploys:
`vercel` then finds the project through the checkout's `.vercel/project.json`, which is checked
against the config, and each run says so. Re-run `drk-deploy init --yes` once to record the owner. It
reads the project again and keeps every other recorded setting. A team config needs nothing: its
`teamId` is its owner.

If you exported `VERCEL_ORG_ID` to get past the old `vercel pull` failure, unset it. It is no longer
passed on, and once the owner is recorded a value that differs from it is refused. A CI job that
exports `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` keeps working as long as they name the recorded
project.

### F-47: the migration URL is named and checked against production

`deploy`, `up` and `migrate` no longer fall back to `DIRECT_DATABASE_URL` or `DATABASE_URL`. If a
deploy of the kit relied on either, set `PRODUCTION_DIRECT_DATABASE_URL` to production's DIRECT
connection string instead, exported in the shell, in the `--from-env` file, or as `--database-url`.
The refusal names the variables it passed over. A satellite is unchanged: it already had to name
`SATELLITE_DIRECT_DATABASE_URL` or `--database-url`.

Every real run now pulls production's settings before it migrates and refuses a URL whose host,
port and database are not production's (see
[above](#what-it-does-about-the-things-that-go-wrong)). The order is now `env:sync`/`env:check` →
link → pull → migrate → build → promote → verify, where it used to migrate first. `migrate` on its
own now needs the Vercel token and links and pulls the same way. Four things to check once:

1. **Production's `DATABASE_URL` is stored `sensitive`.** `vercel pull` cannot read it, so unless a
   readable `DATABASE_URL_UNPOOLED` is there to match instead, the run is refused. Store the direct
   URL on the project as `DATABASE_URL_UNPOOLED`, encrypted. Otherwise pass
   `--allow-unverified-target` on every run, once you have checked the endpoint it prints yourself.
2. **Production sets `DB_SCHEMA`.** Migrations now go to that schema, not `auth`. A `--schema` that
   differs is refused unless `--force-schema`. A `DB_SCHEMA` stored `sensitive` cannot be read: store
   it as plain (it is not a secret), or pass `--schema` with `--allow-unverified-target`.
3. **Production's `DATABASE_URL` is a pooler on its own port** (PgBouncer, Supabase's dedicated
   pooler on 6543) in front of the direct server on 5432. The ports differ, so the direct URL does
   not match it: store the direct URL on the project as `DATABASE_URL_UNPOOLED`, encrypted.
4. **`.drk-deploy.json` carries `migrationUrlEnvVar`.** Nothing ever read it, and it is gone. Name
   the URL with `PRODUCTION_DIRECT_DATABASE_URL` instead.

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

Under `--yes` a build that fails its post-deploy probe is rolled back to the deployment production
served before the job (F-51). The step fails either way. Exit 4 means production was restored, and
exit 3 or 5 means it still needs a person ([above](#what-it-does-about-the-things-that-go-wrong)).

`VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` are not needed: the project comes from `.drk-deploy.json`
(or the file `--config` names). A
job that exports them anyway must name that project, or the run is refused (F-48).

The job deploys the commit it checked out, so that commit must be releasable (F-49). A push to
`main` checked out by `actions/checkout` is: HEAD is `origin/main`, and the install and build above
write only ignored paths. A job for any other ref needs `--allow-ref origin/<branch>`.

If this becomes the deployment path, turn off Vercel's automatic production deploys for the
project. Otherwise a push promotes a build before this has migrated anything, which is the exact race
the ordering above exists to prevent, and `up` refuses to migrate while they are on (F-49).

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
`src/lib/vercel-client.ts` wraps `@vercel/sdk`. `src/lib/vercel-project.ts` builds the environment
of every `vercel` child and checks the checkout's `.vercel/project.json` (F-48): nothing else sets
`VERCEL_ORG_ID` or `VERCEL_PROJECT_ID`, and `test/release.test.ts` asserts that from the source. It
also holds the rule that a satellite config never acts on the SSO issuer's own project (F-50).
`src/lib/config.ts` reads and writes the deployment's config file, the one `--config` or
`DRK_DEPLOY_CONFIG` names (F-50). `src/lib/config-file.ts` holds which file that is, and
`commandFor`, which every `drk-deploy` command a message prints goes through, so that it carries the
same `--config`.
`src/lib/release-tree.ts` reads a checkout's git state (`inspectTree`) and holds the rules for what
may be released and whether Vercel's git integration also deploys production, as pure functions
(F-49). `src/commands/` is one file per command group.
`test/env-presence.test.ts` runs `env:check`, `env:sync` and the `deploy` preflight for real against a
fake Vercel API (`fetch` is replaced), so those tests never reach Vercel either.

The test suite is the only thing standing between a refactor and a silently wrong deployment.
Everything worth relying on is written as a pure function for that reason: keep it that way when you
add a rule. The part that cannot be pure, the release ORDER, goes through a runner instead: `deploy`,
`up` and `migrate` reach every step that touches Vercel, a database or a subprocess (`tree`,
`project`, `serving`, `envSync`, `envCheck`, `link`, `pull`, `migrate`, `build`, `promote`,
`verify`, `rollback`) through `ReleaseRunner` in `src/commands/release.ts`. `test/release.test.ts`
passes a recording fake and asserts that the checkout is read before anything writes, that
production is pulled before anything migrates, that migrations run before the promotion, and that
nothing runs after a failed step, so a new step belongs in the runner. The fake's `tree` answers
for each checkout what a test describes (dirty, unpushed, on a pull request's branch), and its
`project` a project with or without a connected repository (F-49) and with the production aliases a
test gives it, so a satellite config on the kit's project is shown refused by `deploy --yes`,
`--skip-checks`, `up` and `migrate` before anything is linked (F-50). Its `serving` answers the
deployment production serves before the run, and its `verify` a verdict a test chooses, so a failed
probe is shown rolled back to exactly that deployment and probed again (exit 4), left live with the
command printed (exit 3), or stopped after a rollback that failed with nothing run after it (exit 5)
(F-51). The real `rollback` step runs against a stub Vercel CLI that records its arguments, and the
real `serving` and `verify` against a fake API and fake probes, including a satellite whose key is
or is not the kit's. The rule itself, `issuerProjectProblem` in `src/lib/vercel-project.ts`, is
table-tested there too, and `init`, `doctor` and the `env:*` commands run it against a fake Vercel
API. The `--config` wiring is tested by running the built
entry point with a scratch profile and no token, and the hints are run under a selected file to show
each printed command carries it. `inspectTree` itself runs for real against throwaway repositories
the test builds under the OS temp directory, with a bare repository as their remote and the user's
git configuration left out. That shows it reads untracked files, fetches nothing, ignores a shell's
`GIT_DIR` and sets aside only a `next-env.d.ts` a build rewrote. One `deploy` test runs it inside
the release with a fake `build` that rewrites that file, to show the run puts it back and the next
run is not refused. The fake stands in for every step, so the
tests never reach Vercel or a database. Its `pull` writes a production env file where `vercel pull`
would, which is how the production-target refusals (F-47) are asserted: a URL that is not
production's database, a `--schema` production does not read, a value stored `sensitive`, a stale
pulled file. Its `build` records whether that file is still there, because `vercel build` reads it,
and a run with no migrate step is asserted never to parse it. `src/lib/migration-target.ts` holds
those rules as pure functions, table-tested in the same file. The runner's `migrate` step is also
called for real, and both of its refusals are asserted: a satellite on the kit's database, and a
satellite that would inherit the kit's `PRODUCTION_DIRECT_DATABASE_URL` from the shell. Each refuses
before anything connects or spawns. `applyMigrations` runs for real once, against kit scripts that
are a probe, to assert that the runner is handed the URL and the schema and none of the shell's
`PG*` fallbacks.

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
