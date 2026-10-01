import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LOGIN_PASSWORD_ENV, LOGIN_PASSWORD_RE } from "@/db/runtime-login";
// drk-deploy cannot import the kit across its package boundary, so what its
// db:runtime-login step hands the kit's command is held to the kit here, as
// drk-deploy-auth-migration-env.test.ts does for the auth runner.
import {
  RUNTIME_LOGIN_PASSWORD_ENV,
  runtimeLoginEnv,
} from "../../vercel-cli/src/lib/migration-env";

/**
 * What `drk-deploy db:runtime-login` (DEP4) hands `pnpm db:runtime-login`:
 * the owner's URL and the schema, the password under the name the kit reads,
 * and nothing a shell or the kit checkout's `.env` could add. The command runs
 * against production, so a developer's pooled-shape flag or a stray password
 * in that file must not reach it.
 */

const OWNER_URL = "postgresql://neondb_owner:secret@ep-a.x.neon.tech/neondb?sslmode=require";
const PASSWORD = "pw-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx_01";

/** What the child sees: the step's environment layered over the shell, `undefined` dropping a variable. */
/** `null`: no password, as a retire mode passes (an explicit `undefined` would take the default). */
function child(shell: Record<string, string>, password: string | null = PASSWORD) {
  const merged: Record<string, string | undefined> = {
    ...shell,
    ...runtimeLoginEnv(OWNER_URL, "tenant_a", password ?? undefined, shell),
  };
  return Object.fromEntries(
    Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

describe("drk-deploy's db:runtime-login step satisfies the kit (DEP4)", () => {
  it("sets DATABASE_URL to the owner's URL and DB_SCHEMA", () => {
    expect(child({})).toMatchObject({ DATABASE_URL: OWNER_URL, DB_SCHEMA: "tenant_a" });
    expect(
      child({ DATABASE_URL: "postgresql://local/devresponse", DB_SCHEMA: "auth" }),
    ).toMatchObject({ DATABASE_URL: OWNER_URL, DB_SCHEMA: "tenant_a" });
  });

  it("unsets the libpq fallbacks and DB_SEARCH_PATH_VIA_OPTIONS in any spelling", () => {
    const shell = {
      PGHOST: "elsewhere",
      pgport: "5433",
      PgDatabase: "other",
      PGUSER: "someone",
      PGHOSTADDR: "10.0.0.9",
      DB_SEARCH_PATH_VIA_OPTIONS: "0",
      db_search_path_via_options: "0",
    };
    const seen = child(shell);
    for (const key of Object.keys(shell)) expect(seen).not.toHaveProperty(key);
  });

  it("points dotenv at the null device, quietly, with no other file option", () => {
    const seen = child({ DOTENV_PATH: "/somewhere/.env", dotenv_config_path: "/elsewhere/.env" });
    expect(seen.DOTENV_CONFIG_PATH).toBe(devNull);
    expect(seen.DOTENV_CONFIG_QUIET).toBe("true");
    expect(seen).not.toHaveProperty("DOTENV_PATH");
    expect(seen).not.toHaveProperty("dotenv_config_path");
  });

  it("hands the password under the name the kit's command reads, and only one copy of it", () => {
    expect(RUNTIME_LOGIN_PASSWORD_ENV).toBe(LOGIN_PASSWORD_ENV);
    expect(LOGIN_PASSWORD_RE.test(PASSWORD)).toBe(true);
    const seen = child({ db_runtime_login_password: "a-stale-one-from-the-shell-0000000000" });
    expect(seen[LOGIN_PASSWORD_ENV]).toBe(PASSWORD);
    expect(Object.values(seen)).not.toContain("a-stale-one-from-the-shell-0000000000");
    // A retire mode passes none, and removes the shell's.
    expect(child({ DB_RUNTIME_LOGIN_PASSWORD: "from-the-shell" }, null)).not.toHaveProperty(
      LOGIN_PASSWORD_ENV,
    );
    // The kit's script reads the variable from process.env, through runRuntimeLogin.
    const script = readFileSync(path.join(process.cwd(), "scripts/db-runtime-login.ts"), "utf8");
    expect(script).toMatch(/runRuntimeLogin\(\{\s*env: process\.env,/);
    const command = readFileSync(path.join(process.cwd(), "src/db/runtime-login.ts"), "utf8");
    expect(command).toContain("deps.env[LOGIN_PASSWORD_ENV]");
  });

  it("carries no Vercel token", () => {
    const seen = child({ VERCEL_TOKEN: "tok", now_token: "tok2" });
    expect(seen).not.toHaveProperty("VERCEL_TOKEN");
    expect(seen).not.toHaveProperty("now_token");
    expect(Object.values(seen)).not.toContain("tok");
  });

  it("keeps the kit checkout's .env from the command, which reads it through dotenv/config", () => {
    const script = readFileSync(path.join(process.cwd(), "scripts/db-runtime-login.ts"), "utf8");
    expect(script.startsWith('import "dotenv/config";\n')).toBe(true);
    const checkout = mkdtempSync(path.join(tmpdir(), "drk-runtime-login-env-"));
    try {
      writeFileSync(
        path.join(checkout, ".env"),
        "DB_SEARCH_PATH_VIA_OPTIONS=0\nDB_RUNTIME_LOGIN_PASSWORD=from-a-developer-env-file-00000000\n",
      );
      const dotenvConfig = createRequire(import.meta.url).resolve("dotenv/config");
      const probe = `require(${JSON.stringify(dotenvConfig)}); console.log(JSON.stringify({ flag: process.env.DB_SEARCH_PATH_VIA_OPTIONS ?? null, password: process.env.DB_RUNTIME_LOGIN_PASSWORD ?? null }));`;
      const system: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      };
      const seen = (env: Record<string, string>) =>
        JSON.parse(
          execFileSync(process.execPath, ["-e", probe], {
            cwd: checkout,
            env: { ...system, ...env } as NodeJS.ProcessEnv,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }),
        );
      // Without the step's environment the file is read; with it, nothing is.
      expect(seen({})).toEqual({ flag: "0", password: "from-a-developer-env-file-00000000" });
      expect(seen(child({}, null))).toEqual({ flag: null, password: null });
      expect(seen(child({}))).toEqual({ flag: null, password: PASSWORD });
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});
