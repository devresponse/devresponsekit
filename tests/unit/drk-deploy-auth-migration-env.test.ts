import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { invalidServerEnvKeys } from "@/lib/env";
// drk-deploy cannot import the kit across its package boundary (its tsconfig
// `rootDir` is its own `src`), so what its migrate step hands the kit's auth
// runner is held to the kit here, where both halves can be imported, as
// drk-deploy-required-keys.test.ts does for env:sync's required set.
import {
  AUTH_MIGRATION_PLACEHOLDERS,
  authMigrationEnv,
  migrationEnv,
} from "../../vercel-cli/src/lib/migration-env";

/**
 * `drk-deploy`'s `db:auth:migrate` step needs only the database URL (F-141).
 *
 * The runner imports `@/lib/auth` for Better Auth's options, and the import
 * validates the whole server environment. drk-deploy used to hand it the URL
 * and the schema alone, so the rest came from the operator's shell or from the
 * kit checkout's `.env`: the README's CI job had neither and failed on every
 * run, after the application's migrations had committed. The step now carries
 * a placeholder for each required value the shell does not set, and points
 * the runner's `dotenv/config` at the null device. Both halves are pinned here:
 *
 * - the placeholders are exactly the kit's required keys less DATABASE_URL,
 *   and with the URL they pass its schema in every NODE_ENV, so a key the kit
 *   starts requiring fails this suite rather than every drk-deploy migration;
 * - the runner still loads its environment through `dotenv/config`, and under
 *   the step's environment that loads nothing from the checkout's `.env`,
 *   where the application runner's still does.
 */

const DATABASE_URL = "postgresql://owner:secret@db.example.com:5432/app";

/** The variables a child is handed, without the `undefined` entries that unset one. */
function defined(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

describe("drk-deploy's auth migration step satisfies the kit (F-141)", () => {
  it("has a placeholder for exactly the required keys it is not otherwise handed", () => {
    const required = invalidServerEnvKeys({ NODE_ENV: "production" }).filter(
      (key) => key !== "DATABASE_URL",
    );
    expect(Object.keys(AUTH_MIGRATION_PLACEHOLDERS).sort()).toEqual(required);
  });

  it.each([undefined, "development", "production"])(
    "passes the kit's env schema with nothing else set (NODE_ENV=%s)",
    (nodeEnv) => {
      const env = defined(authMigrationEnv(DATABASE_URL, "auth", {}));
      const source = { ...env, ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}) } as NodeJS.ProcessEnv;
      expect(invalidServerEnvKeys(source)).toEqual([]);
    },
  );

  it("leaves a shell's COOKIE_DOMAIN and API_JWT_ISSUER out beside the placeholder BETTER_AUTH_URL, and checks them beside a real one", () => {
    // The kit checks both against BETTER_AUTH_URL (the cookie domain must
    // cover its host, the JWT issuer must equal it under MCP_ENABLED), so a
    // real one could only fail next to the placeholder.
    // What the runner sees: the step's environment layered over the shell,
    // where an `undefined` drops the shell's variable.
    const child = (shell: Record<string, string>) =>
      defined({ ...shell, ...authMigrationEnv(DATABASE_URL, "auth", shell) }) as NodeJS.ProcessEnv;
    const shell = {
      NODE_ENV: "production",
      MCP_ENABLED: "1",
      COOKIE_DOMAIN: ".example.com",
      API_JWT_ISSUER: "https://kit.example.com",
    };
    expect(invalidServerEnvKeys(child(shell))).toEqual([]);
    expect(child(shell)).not.toHaveProperty("COOKIE_DOMAIN");
    expect(child(shell)).not.toHaveProperty("API_JWT_ISSUER");

    // Beside a real BETTER_AUTH_URL they are kept, and validated as before.
    const kit = { ...shell, BETTER_AUTH_URL: "https://kit.example.com" };
    expect(child(kit)).toMatchObject(kit);
    expect(invalidServerEnvKeys(child(kit))).toEqual([]);
    expect(
      invalidServerEnvKeys(child({ ...kit, BETTER_AUTH_URL: "https://kit.other.com" })),
    ).toEqual(["API_JWT_ISSUER", "COOKIE_DOMAIN"]);
  });

  it("keeps the kit's .env from the auth runner, which reads it through dotenv/config", () => {
    const runner = readFileSync(
      path.join(process.cwd(), "src/db/migrations/run-better-auth-migrate.ts"),
      "utf8",
    );
    expect(runner.startsWith('import "dotenv/config";\n')).toBe(true);

    const checkout = mkdtempSync(path.join(tmpdir(), "drk-auth-migration-env-"));
    try {
      // A developer's `.env`: another secret, and the local SSO rig's cookie
      // domain, which does not cover the placeholder BETTER_AUTH_URL.
      writeFileSync(
        path.join(checkout, ".env"),
        "BETTER_AUTH_SECRET=from-a-developer-env-file-0000000000\nCOOKIE_DOMAIN=.devresponse.local\n",
      );
      const dotenvConfig = createRequire(import.meta.url).resolve("dotenv/config");
      const probe = `require(${JSON.stringify(dotenvConfig)}); console.log(JSON.stringify({ secret: process.env.BETTER_AUTH_SECRET ?? null, cookieDomain: process.env.COOKIE_DOMAIN ?? null }));`;
      const system = defined({ PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT });
      const seen = (env: Record<string, string | undefined>) =>
        JSON.parse(
          execFileSync(process.execPath, ["-e", probe], {
            cwd: checkout,
            env: { ...system, ...defined(env) } as NodeJS.ProcessEnv,
            encoding: "utf8",
            // dotenv's own "injected env" line goes to stderr.
            stdio: ["ignore", "pipe", "ignore"],
          }),
        );

      // The application runner's environment: the file is read, so the probe
      // can see one.
      expect(seen(migrationEnv(DATABASE_URL, "auth", {}))).toEqual({
        secret: "from-a-developer-env-file-0000000000",
        cookieDomain: ".devresponse.local",
      });
      // The auth runner's: nothing from it, the placeholder in its place.
      expect(seen(authMigrationEnv(DATABASE_URL, "auth", {}))).toEqual({
        secret: AUTH_MIGRATION_PLACEHOLDERS.BETTER_AUTH_SECRET,
        cookieDomain: null,
      });
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});
