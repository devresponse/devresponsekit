import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BetterAuthMigrationPlan, checkDatabase } from "@/db/migrations/deploy-gate-check";
import { REQUIRED_CORE_MIGRATIONS } from "@/db/migrations/migration-plan";
import { listRuntimeLoginMembers } from "@/db/migrations/runtime-privileges-db";
import { resolveDatabaseUrl } from "@/db/schema-config";

/**
 * DB-BACKED proof of the production build's schema gate (DEP1): the one
 * attempt (`checkDatabase`) against a live Postgres, and the script the build
 * runs, end to end, as a child process.
 *
 * A scratch schema stands in for production's, migrated by the real runners
 * (`db:auth:migrate`, then `db:app:migrate`, with DB_SCHEMA pointing at it),
 * so the ledger, its checksums, the Better Auth tables and the 0005 runtime
 * role are exactly what a deploy leaves behind.
 *
 *   a. A fresh, empty schema is behind: no ledger.
 *   b. Migrated, it is ok, as the owner; as the 0005 runtime role it is ok
 *      too and reports a non-owner.
 *   c. A ledger checksum that differs from this build's file is fatal.
 *   d. A missing ledger row is behind, naming the id.
 *   e. A connection whose search_path misses the schema is behind.
 *   f. The script, as a production build runs it: exit 0, PASS and the
 *      target line, no password; and exit 1 with FAIL when the ledger lacks
 *      a migration.
 *   g. A preview build exits 0 at once, without connecting.
 *   h. Better Auth's half: each kind of gap in its plan is behind, by name and
 *      beside the ledger's; a schema problem or an unsafe change is fatal.
 *   i. A Better Auth column really dropped is behind, and db:auth:migrate
 *      puts back what the gate named.
 *   j. A ledger the login cannot read (42501), or one with no checksum
 *      column (42703), is behind.
 *   k. The runtime's privileges, once the schema is current (DEP3): a
 *      non-owner missing a grant, or holding a ledger write, is behind; one
 *      that belongs to a role bypassing its grants is fatal; and an owner
 *      build fails the ratchet once a LOGIN member of the runtime role exists,
 *      but never on the ADMIN-only membership a non-superuser owner (Neon's
 *      neondb_owner) gets by creating that role.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts).
 */
const SCHEMA = "__dbtest_gate";
const RUNTIME_ROLE = `${SCHEMA}_runtime`;
const LOGIN_ROLE = `${SCHEMA}_app_login`;
/** (k)'s non-superuser owner, and the roles it creates; no schema needed. */
const NEON_SCHEMA = `${SCHEMA}_neon`;
const NEON_OWNER = `${NEON_SCHEMA}_owner`;
const NEON_RUNTIME = `${NEON_SCHEMA}_runtime`;
const NEON_LOGIN = `${NEON_SCHEMA}_app_login`;
const ROOT = process.cwd();
const RELEASE = "0002-release.sql";
const FILES = new Map(
  REQUIRED_CORE_MIGRATIONS.map((id) => [
    id,
    readFileSync(path.join(ROOT, "src/db/migrations", id), "utf8"),
  ]),
);

const DATABASE_URL = resolveDatabaseUrl()!;
/** Plain pool with no search_path option: the scratch schema's DDL, qualified. */
let admin: Pool;
const pools: Pool[] = [];
let betterAuth: (pool: Pool) => Promise<BetterAuthMigrationPlan>;
let endAppPool: (() => Promise<void>) | undefined;

/**
 * A pool the way `createAppPool` builds one for DB_SCHEMA=`schema`. One
 * connection, never closed while idle, so a session-level `set role` holds
 * for every later query.
 */
function gatePool(schema: string): Pool {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    options: `-c search_path="${schema}",public`,
    max: 1,
    idleTimeoutMillis: 0,
  });
  pools.push(pool);
  return pool;
}

const check = (pool: Pool) => checkDatabase(pool, { schema: SCHEMA, files: FILES, betterAuth });

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Runs a repository script with tsx, as `pnpm <script>` would, in `env`. */
function runScript(script: string, env: Record<string, string | undefined>): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      cwd: ROOT,
      // Next types NODE_ENV as always set; the gate runs with whatever the build has.
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
  });
}

/** What a process needs to start on this OS (Windows: SystemRoot, PATH, TEMP), and nothing else. */
const SYSTEM_VARIABLES =
  /^(?:path|pathext|systemroot|systemdrive|windir|comspec|temp|tmp|tmpdir|home|userprofile|homedrive|homepath|appdata|localappdata|programdata|lang|tz|lc_\w+)$/i;

/**
 * The gate's environment as a production build would hand it over: no
 * `.env` (the gate reads none), the variables named, and the CI placeholders
 * `@/lib/auth` validates at load, as migrate-production.yml's auth step gives
 * them.
 */
function gateEnv(extra: Record<string, string>): Record<string, string | undefined> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => SYSTEM_VARIABLES.test(key)),
    ),
    BETTER_AUTH_SECRET: "ci-only-better-auth-secret-not-for-production",
    BETTER_AUTH_URL: "http://localhost:3000",
    SSO_HANDOFF_ISSUER: "http://localhost:3000",
    SSO_HANDOFF_AUDIENCE_PREFIX: "devresponse-app",
    SSO_HANDOFF_APPLICATION_ID: "portal",
    ...extra,
  };
}

/** The login and runtime role go first: the owner granted their memberships. */
async function dropNeonOwnerScratch(): Promise<void> {
  for (const role of [NEON_LOGIN, NEON_RUNTIME, NEON_OWNER]) {
    await admin.query(`drop role if exists "${role}"`);
  }
}

async function dropScratch(): Promise<void> {
  await dropNeonOwnerScratch();
  await admin.query(`drop schema if exists "${SCHEMA}" cascade`);
  await admin.query(`drop role if exists "${LOGIN_ROLE}"`);
  const { rows } = await admin.query("select 1 from pg_roles where rolname = $1", [RUNTIME_ROLE]);
  if (rows.length > 0) {
    await admin.query(`drop owned by "${RUNTIME_ROLE}"`);
    await admin.query(`drop role if exists "${RUNTIME_ROLE}"`);
  }
}

async function ledgerChecksum(id: string): Promise<string | null> {
  const { rows } = await admin.query<{ checksum: string | null }>(
    `select checksum from "${SCHEMA}".app_schema_migrations where id = $1`,
    [id],
  );
  return rows[0]?.checksum ?? null;
}

beforeAll(async () => {
  admin = new Pool({ connectionString: DATABASE_URL, max: 1 });
  await dropScratch();
  await admin.query(`create schema "${SCHEMA}"`);
  const { auth } = await import("@/lib/auth");
  const { pgPool } = await import("@/db/database");
  endAppPool = () => pgPool.end();
  const { getMigrations } = await import("better-auth/db/migration");
  betterAuth = (database) =>
    getMigrations(
      { ...(auth.options as Parameters<typeof getMigrations>[0]), database },
      { throwOnUnsafe: false },
    );
});

afterAll(async () => {
  try {
    for (const pool of pools) await pool.end().catch(() => {});
    await endAppPool?.().catch(() => {});
    await dropScratch();
  } finally {
    await admin.end();
  }
});

describe("the schema gate against a live database (DEP1)", () => {
  it("(a) calls a fresh schema behind: it has no ledger", async () => {
    const result = await check(gatePool(SCHEMA));
    expect(result.status).toBe("behind");
    expect(result.reasons).toEqual([
      "no migration ledger: app_schema_migrations does not exist in this schema",
    ]);
    expect(result.identity?.currentSchema).toBe(SCHEMA);
  });

  it("(b) passes once both migrators have run, as the owner and as the runtime role", async () => {
    const env = { ...process.env, DB_SCHEMA: SCHEMA };
    for (const script of [
      "src/db/migrations/run-better-auth-migrate.ts",
      "src/db/migrations/run-migrations.ts",
    ]) {
      const ran = await runScript(script, env);
      expect(ran.code, `${script}\n${ran.stdout}\n${ran.stderr}`).toBe(0);
    }

    const owner = await check(gatePool(SCHEMA));
    expect(owner).toMatchObject({ status: "ok", reasons: [], warnings: [] });
    expect(owner.identity).toEqual({
      currentUser: decodeURIComponent(new URL(DATABASE_URL).username),
      currentSchema: SCHEMA,
      isOwner: true,
    });

    // 0005's least-privilege role reads the ledger and Better Auth's tables,
    // and is reported as what it is.
    const asRuntime = gatePool(SCHEMA);
    await asRuntime.query(`set role "${RUNTIME_ROLE}"`);
    const runtime = await check(asRuntime);
    expect(runtime).toMatchObject({ status: "ok", reasons: [] });
    expect(runtime.identity).toEqual({
      currentUser: RUNTIME_ROLE,
      currentSchema: SCHEMA,
      isOwner: false,
    });
  }, 240_000);

  it("(c) is fatal when the ledger holds another version of a migration", async () => {
    const original = await ledgerChecksum(RELEASE);
    await admin.query(
      `update "${SCHEMA}".app_schema_migrations set checksum = repeat('0', 64) where id = $1`,
      [RELEASE],
    );
    try {
      const result = await check(gatePool(SCHEMA));
      expect(result.status).toBe("fatal");
      expect(result.reasons).toEqual([
        expect.stringMatching(
          /^the database holds a different version of 0002-release\.sql than this build \(ledger 000000000000…, this build's file [0-9a-f]{12}…\)$/,
        ),
      ]);
    } finally {
      await admin.query(
        `update "${SCHEMA}".app_schema_migrations set checksum = $2 where id = $1`,
        [RELEASE, original],
      );
    }
  });

  it("(d) is behind, naming the id, when a ledger row is missing", async () => {
    const original = await ledgerChecksum(RELEASE);
    await admin.query(`delete from "${SCHEMA}".app_schema_migrations where id = $1`, [RELEASE]);
    try {
      const result = await check(gatePool(SCHEMA));
      expect(result.status).toBe("behind");
      expect(result.reasons).toEqual([`the ledger lacks ${RELEASE}`]);
    } finally {
      await admin.query(
        `insert into "${SCHEMA}".app_schema_migrations (id, checksum) values ($1, $2)`,
        [RELEASE, original],
      );
    }
  });

  it("(e) is behind when the connection's search_path misses the schema", async () => {
    const result = await check(gatePool("public"));
    expect(result.status).toBe("behind");
    expect(result.reasons).toEqual([
      `search_path resolves to public, not DB_SCHEMA ${SCHEMA}: the schema is missing or the runtime role's search_path default is wrong`,
    ]);
  });

  it("(f) the script passes a production build, prints the target line, and never the password", async () => {
    const ran = await runScript(
      "scripts/deploy-gate.ts",
      gateEnv({
        VERCEL_ENV: "production",
        DEPLOY_GATE_WAIT_MS: "0",
        DATABASE_URL,
        DB_SCHEMA: SCHEMA,
      }),
    );
    expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);
    const url = new URL(DATABASE_URL);
    const lines = ran.stdout.split(/\r?\n/).filter((line) => line.startsWith("[deploy-gate]"));
    expect(lines[0]).toMatch(
      /^\[deploy-gate\] verify env=production infra=local commit=\S+ wait=0s$/,
    );
    expect(lines).toContain(
      `[deploy-gate] target host=${url.hostname} port=${url.port || "5432"} database=${url.pathname.slice(1)} schema=${SCHEMA} user=${decodeURIComponent(url.username)} runtime=owner`,
    );
    expect(lines.at(-1)).toMatch(
      /^\[deploy-gate\] PASS schema current after [\d.]+s runtime=owner$/,
    );
    expect(ran.stdout).not.toContain(DATABASE_URL);
    const password = decodeURIComponent(url.password);
    if (password) {
      expect(ran.stdout).not.toContain(`:${password}@`);
      const elsewhere = [url.hostname, url.pathname, decodeURIComponent(url.username)].some(
        (part) => part.includes(password),
      );
      if (!elsewhere) expect(ran.stdout + ran.stderr).not.toContain(password);
    }
  }, 120_000);

  it("(f) the script fails a production build whose ledger lacks a migration", async () => {
    const original = await ledgerChecksum(RELEASE);
    await admin.query(`delete from "${SCHEMA}".app_schema_migrations where id = $1`, [RELEASE]);
    try {
      const ran = await runScript(
        "scripts/deploy-gate.ts",
        gateEnv({
          VERCEL_ENV: "production",
          DEPLOY_GATE_WAIT_MS: "0",
          DATABASE_URL,
          DB_SCHEMA: SCHEMA,
        }),
      );
      expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(1);
      expect(ran.stdout).toContain(`[deploy-gate] attempt 1 behind: the ledger lacks ${RELEASE}`);
      expect(ran.stdout).toContain(
        `[deploy-gate] FAIL behind: the ledger lacks ${RELEASE}. Production was not changed: Vercel does not promote a failed build.`,
      );
    } finally {
      await admin.query(
        `insert into "${SCHEMA}".app_schema_migrations (id, checksum) values ($1, $2)`,
        [RELEASE, original],
      );
    }
  }, 120_000);

  it("(g) a preview build exits 0 at once, without connecting", async () => {
    const ran = await runScript(
      "scripts/deploy-gate.ts",
      gateEnv({
        VERCEL_ENV: "preview",
        DATABASE_URL: "postgresql://x:y@127.0.0.1:1/none",
      }),
    );
    expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);
    expect(ran.stdout.trim()).toBe("[deploy-gate] skip vercel-env=preview");
    expect(ran.ms).toBeLessThan(5_000);
  }, 30_000);

  describe("(h) Better Auth's plan, on the migrated schema", () => {
    const EMPTY: BetterAuthMigrationPlan = {
      toBeCreated: [],
      toBeAdded: [],
      toBeAddedIndexes: [],
      unsafeChanges: [],
      schemaProblems: [],
    };
    /** One attempt whose ledger half is real and whose Better Auth plan is `plan`. */
    const withPlan = (plan: Partial<BetterAuthMigrationPlan>) =>
      checkDatabase(gatePool(SCHEMA), {
        schema: SCHEMA,
        files: FILES,
        betterAuth: async () => ({ ...EMPTY, ...plan }),
      });

    it.each<[string, Partial<BetterAuthMigrationPlan>, string[]]>([
      [
        "a table to create",
        { toBeCreated: [{ table: "rateLimit" }, { table: "twoFactor" }] },
        ["Better Auth table(s) missing: rateLimit, twoFactor"],
      ],
      [
        "a column to add",
        {
          toBeAdded: [
            { table: "user", fields: { role: {}, banned: {} } },
            { table: "session", fields: { impersonatedBy: {} } },
          ],
        },
        ["Better Auth column(s) missing: user.role, user.banned, session.impersonatedBy"],
      ],
      [
        "an index to add",
        { toBeAddedIndexes: [{ table: "session", name: "session_userId_idx" }] },
        ["Better Auth index(es) missing: session.session_userId_idx"],
      ],
      [
        "all three",
        {
          toBeCreated: [{ table: "rateLimit" }],
          toBeAdded: [{ table: "user", fields: { role: {} } }],
          toBeAddedIndexes: [{ table: "account", name: "account_userId_idx" }],
        },
        [
          "Better Auth table(s) missing: rateLimit",
          "Better Auth column(s) missing: user.role",
          "Better Auth index(es) missing: account.account_userId_idx",
        ],
      ],
    ])("%s is behind, by name", async (_, plan, reasons) => {
      expect(await withPlan(plan)).toMatchObject({ status: "behind", reasons });
    });

    it("names Better Auth's gaps beside the ledger's, in one attempt", async () => {
      const original = await ledgerChecksum(RELEASE);
      await admin.query(`delete from "${SCHEMA}".app_schema_migrations where id = $1`, [RELEASE]);
      try {
        expect(
          await withPlan({ toBeAdded: [{ table: "user", fields: { role: {} } }] }),
        ).toMatchObject({
          status: "behind",
          reasons: [`the ledger lacks ${RELEASE}`, "Better Auth column(s) missing: user.role"],
        });
      } finally {
        await admin.query(
          `insert into "${SCHEMA}".app_schema_migrations (id, checksum) values ($1, $2)`,
          [RELEASE, original],
        );
      }
    });

    it("is fatal on a schema problem or an unsafe change, whatever else is missing", async () => {
      expect(
        await withPlan({ unsafeChanges: ["user.tier is required and has no default"] }),
      ).toMatchObject({
        status: "fatal",
        reasons: ["Better Auth: user.tier is required and has no default"],
      });
      expect(
        await withPlan({
          schemaProblems: ["session.legacy is required, and Better Auth never writes it"],
          unsafeChanges: ["user.tier is required and has no default"],
          toBeCreated: [{ table: "rateLimit" }],
        }),
      ).toMatchObject({
        status: "fatal",
        reasons: [
          "Better Auth: session.legacy is required, and Better Auth never writes it",
          "Better Auth: user.tier is required and has no default",
        ],
      });
    });
  });

  it("(i) is behind while a Better Auth column is missing, until db:auth:migrate restores it", async () => {
    // A column, not an index: better-auth 1.7.6 plans the table-level indexes
    // a schema declares, not a field's own (a dropped session_userId_idx is
    // neither reported nor re-created), so there is no real index case here.
    await admin.query(`alter table "${SCHEMA}"."session" drop column "userAgent"`);
    try {
      const result = await check(gatePool(SCHEMA));
      expect(result.status).toBe("behind");
      expect(result.reasons).toEqual(["Better Auth column(s) missing: session.userAgent"]);
    } finally {
      const ran = await runScript("src/db/migrations/run-better-auth-migrate.ts", {
        ...process.env,
        DB_SCHEMA: SCHEMA,
      });
      expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);
    }
    expect(await check(gatePool(SCHEMA))).toMatchObject({ status: "ok", reasons: [] });
  }, 240_000);

  it("(j) is behind when the login cannot read the ledger (42501), or the ledger has no checksum column (42703)", async () => {
    await admin.query(`revoke select on "${SCHEMA}".app_schema_migrations from "${RUNTIME_ROLE}"`);
    try {
      const asRuntime = gatePool(SCHEMA);
      await asRuntime.query(`set role "${RUNTIME_ROLE}"`);
      expect(await check(asRuntime)).toMatchObject({
        status: "behind",
        reasons: [
          "the runtime role cannot read the ledger: grant it SELECT on app_schema_migrations",
        ],
      });
    } finally {
      await admin.query(`grant select on "${SCHEMA}".app_schema_migrations to "${RUNTIME_ROLE}"`);
    }

    await admin.query(
      `alter table "${SCHEMA}".app_schema_migrations rename column checksum to checksum_moved`,
    );
    try {
      expect(await check(gatePool(SCHEMA))).toMatchObject({
        status: "behind",
        reasons: [
          "the ledger has no checksum column (written before review #86): db:app:migrate adds it",
        ],
      });
    } finally {
      await admin.query(
        `alter table "${SCHEMA}".app_schema_migrations rename column checksum_moved to checksum`,
      );
    }
    expect(await check(gatePool(SCHEMA))).toMatchObject({ status: "ok", reasons: [] });
  });
  describe("(k) the runtime's privileges, once the schema is current (DEP3)", () => {
    /** One attempt as the runtime role (`set role`), a non-owner. */
    const asRuntime = async () => {
      const pool = gatePool(SCHEMA);
      await pool.query(`set role "${RUNTIME_ROLE}"`);
      return check(pool);
    };

    it("passes a non-owner that holds exactly the manifest", async () => {
      expect(await asRuntime()).toMatchObject({ status: "ok", reasons: [] });
    });

    it("is behind while a grant is missing", async () => {
      await admin.query(`revoke insert on "${SCHEMA}".app_outbox from "${RUNTIME_ROLE}"`);
      try {
        expect(await asRuntime()).toMatchObject({
          status: "behind",
          reasons: [
            "the runtime login lacks INSERT on app_outbox: db:app:migrate's reconcile grants them",
          ],
        });
      } finally {
        await admin.query(`grant insert on "${SCHEMA}".app_outbox to "${RUNTIME_ROLE}"`);
      }
    });

    it("is behind while it holds a ledger write the manifest forbids", async () => {
      await admin.query(`grant insert on "${SCHEMA}".app_schema_migrations to "${RUNTIME_ROLE}"`);
      try {
        const result = await asRuntime();
        expect(result.status).toBe("behind");
        expect(result.reasons).toEqual([
          expect.stringMatching(
            /^the runtime login holds INSERT on app_schema_migrations, which the privilege manifest forbids/,
          ),
        ]);
      } finally {
        await admin.query(
          `revoke insert on "${SCHEMA}".app_schema_migrations from "${RUNTIME_ROLE}"`,
        );
      }
    });

    it("is fatal when it belongs to a role that bypasses its grants", async () => {
      await admin.query(`grant pg_read_all_data to "${RUNTIME_ROLE}"`);
      try {
        const result = await asRuntime();
        expect(result.status).toBe("fatal");
        expect(result.reasons).toEqual([
          expect.stringMatching(/^the runtime login is a member of pg_read_all_data, /),
        ]);
      } finally {
        await admin.query(`revoke pg_read_all_data from "${RUNTIME_ROLE}"`);
      }
    });

    it("the ratchet: an owner build is fatal once a LOGIN member of the runtime role exists", async () => {
      expect(await check(gatePool(SCHEMA))).toMatchObject({ status: "ok", reasons: [] });
      await admin.query(`create role "${LOGIN_ROLE}" login`);
      try {
        await admin.query(`grant "${RUNTIME_ROLE}" to "${LOGIN_ROLE}"`);
        const result = await check(gatePool(SCHEMA));
        expect(result.status).toBe("fatal");
        expect(result.reasons).toEqual([
          `a least-privilege login (${LOGIN_ROLE}) exists for this schema but this build connects as the owner ${decodeURIComponent(new URL(DATABASE_URL).username)}; point DATABASE_URL at the login (pnpm db:runtime-login, docs/deployment.md §8.3), or follow the break-glass procedure in docs/deployment.md §8.5`,
        ]);
        // The break-glass step: a login that can no longer log in is no
        // longer counted, and the owner build passes again.
        await admin.query(`alter role "${LOGIN_ROLE}" nologin`);
        expect(await check(gatePool(SCHEMA))).toMatchObject({ status: "ok", reasons: [] });
      } finally {
        await admin.query(`drop role if exists "${LOGIN_ROLE}"`);
      }
    });

    it("the ratchet never counts the membership a non-superuser owner gets by creating the runtime role", async () => {
      // Neon's shape: neondb_owner, a non-superuser CREATEROLE login, created
      // auth_runtime in 0005, and Postgres 16+ made it an ADMIN-only member of
      // it. The (k) case above runs as a superuser, which gets no such
      // membership; counting this one would fail every production build.
      const asOwner = gatePool(SCHEMA);
      await admin.query(`create role "${NEON_OWNER}" login createrole`);
      try {
        await asOwner.query(`set role "${NEON_OWNER}"`);
        await asOwner.query(`create role "${NEON_RUNTIME}" nologin`);
        const { rows } = await admin.query(
          `select m.admin_option, m.inherit_option, m.set_option
             from pg_auth_members m
            where m.roleid = $1::regrole and m.member = $2::regrole`,
          [NEON_RUNTIME, NEON_OWNER],
        );
        expect(rows).toEqual([{ admin_option: true, inherit_option: false, set_option: false }]);
        expect(await listRuntimeLoginMembers(asOwner, NEON_SCHEMA)).toEqual([]);
        expect(await listRuntimeLoginMembers(admin, NEON_SCHEMA)).toEqual([]);

        // A login the owner makes the way db:runtime-login does is counted.
        await asOwner.query(`create role "${NEON_LOGIN}" login`);
        await asOwner.query(
          `grant "${NEON_RUNTIME}" to "${NEON_LOGIN}" with inherit true, set false`,
        );
        expect(await listRuntimeLoginMembers(asOwner, NEON_SCHEMA)).toEqual([NEON_LOGIN]);
        expect(await listRuntimeLoginMembers(admin, NEON_SCHEMA)).toEqual([NEON_LOGIN]);

        // createrole_self_grant (16+) makes the creator an inheriting member;
        // the build's own user is still never counted.
        await admin.query(`grant "${NEON_RUNTIME}" to "${NEON_OWNER}" with inherit true`);
        expect(await listRuntimeLoginMembers(asOwner, NEON_SCHEMA)).toEqual([NEON_LOGIN]);
      } finally {
        await asOwner.query("reset role");
        await dropNeonOwnerScratch();
      }
    });
  });
});
