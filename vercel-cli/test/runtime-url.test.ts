import assert from "node:assert/strict";
import { test } from "node:test";

// Tests run against the BUILT output, so they exercise exactly what ships.
import { CliError } from "../dist/lib/log.js";
import { neonPooledHost, runtimeHost, runtimeUrl } from "../dist/lib/runtime-url.js";

/*
 * DEP4: the runtime DATABASE_URL `drk-deploy db:runtime-login` writes to
 * Vercel, built from the owner's DIRECT URL.
 */

const PASSWORD = "pw-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx_01";
const LOGIN = "auth_app_202610011234";
const OWNER_SECRET = "owner-secret-never-printed";
const NEON_DIRECT = `postgresql://neondb_owner:${OWNER_SECRET}@ep-quiet-cell-123456.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require&options=-c%20search_path%3Dauth&application_name=kit&host=elsewhere`;

/** A refusal with exit 2 whose message and hint carry neither password. */
function refused(fn: () => unknown, message: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof CliError, String(err));
    assert.equal(err.exitCode, 2);
    assert.match(err.message, message);
    for (const secret of [PASSWORD, OWNER_SECRET]) {
      assert.ok(!`${err.message} ${err.hint ?? ""}`.includes(secret), "no secret in a refusal");
    }
    return true;
  });
}

test("DEP4: Neon's direct host becomes its pooled one: -pooler after the endpoint id", () => {
  assert.equal(
    neonPooledHost("ep-quiet-cell-123456.us-east-2.aws.neon.tech"),
    "ep-quiet-cell-123456-pooler.us-east-2.aws.neon.tech",
  );
  assert.equal(
    neonPooledHost("ep-x-123.c-2.eu-central-1.aws.neon.tech"),
    "ep-x-123-pooler.c-2.eu-central-1.aws.neon.tech",
  );
  assert.equal(neonPooledHost("ep-x-123-pooler.us-east-2.aws.neon.tech"), null, "already pooled");
  assert.equal(neonPooledHost("db.example.com"), null, "not Neon");
  assert.equal(neonPooledHost("neon.tech.example.com"), null, "not Neon either");
});

test("DEP4: the pooled runtime URL: the login, Neon's pooled host, the port and database, TLS kept, the rest dropped", () => {
  const url = new URL(runtimeUrl(NEON_DIRECT, { login: LOGIN, password: PASSWORD, endpoint: "pooled" }));
  assert.equal(url.protocol, "postgresql:");
  assert.equal(url.username, LOGIN);
  assert.equal(url.password, PASSWORD, "base64url embeds unescaped");
  assert.equal(url.hostname, "ep-quiet-cell-123456-pooler.us-east-2.aws.neon.tech");
  assert.equal(url.port, "");
  assert.equal(url.pathname, "/neondb");
  // sslmode and channel_binding kept; `options` (which the pooler refuses),
  // `application_name` and a re-pointing `host` dropped.
  assert.deepEqual([...url.searchParams.keys()], ["sslmode", "channel_binding"]);
  assert.equal(url.searchParams.get("sslmode"), "require");
  assert.equal(url.searchParams.get("channel_binding"), "require");
  assert.equal(url.hash, "");
});

test("DEP4: direct keeps the owner's host; --pooled-host names another provider's; the port is kept", () => {
  const direct = new URL(
    runtimeUrl("postgres://owner:pw@db.internal.example:6000/app?sslmode=verify-full", {
      login: LOGIN,
      password: PASSWORD,
      endpoint: "direct",
    }),
  );
  assert.deepEqual(
    [direct.hostname, direct.port, direct.pathname, direct.search],
    ["db.internal.example", "6000", "/app", "?sslmode=verify-full"],
  );
  const named = new URL(
    runtimeUrl("postgres://owner:pw@db.internal.example:6000/app", {
      login: LOGIN,
      password: PASSWORD,
      endpoint: "pooled",
      pooledHost: "pgbouncer.internal.example",
    }),
  );
  assert.deepEqual([named.hostname, named.port, named.search], ["pgbouncer.internal.example", "6000", ""]);
  assert.equal(
    runtimeHost(NEON_DIRECT, { endpoint: "direct" }),
    "ep-quiet-cell-123456.us-east-2.aws.neon.tech",
  );
});

test("DEP4: refused, with no password in any message: a pooled owner, a non-Neon host without --pooled-host, a bad --pooled-host", () => {
  const options = { login: LOGIN, password: PASSWORD } as const;
  refused(
    () =>
      runtimeUrl(
        `postgresql://neondb_owner:${OWNER_SECRET}@ep-quiet-cell-123456-pooler.us-east-2.aws.neon.tech/neondb`,
        {
          ...options,
          endpoint: "pooled",
        },
      ),
    /^The owner URL is already pooled: its host carries Neon's `-pooler` suffix\.$/,
  );
  refused(
    () =>
      runtimeUrl(`postgres://owner:${OWNER_SECRET}@db.example.com:6543/app`, {
        ...options,
        endpoint: "direct",
      }),
    /already pooled: it uses port 6543/,
  );
  refused(
    () =>
      runtimeUrl(`postgres://owner:${OWNER_SECRET}@db.example.com/app`, { ...options, endpoint: "pooled" }),
    /^The pooled host of db\.example\.com cannot be derived: only Neon's can\.$/,
  );
  for (const pooledHost of ["db.example.com:6432", "https://db.example.com", "db.example.com/app", ""]) {
    refused(
      () =>
        runtimeUrl(`postgres://owner:${OWNER_SECRET}@db.example.com/app`, {
          ...options,
          endpoint: "pooled",
          pooledHost,
        }),
      /^--pooled-host .* is not a host name/,
    );
  }
  refused(
    () => runtimeUrl(NEON_DIRECT, { ...options, endpoint: "direct", pooledHost: "x.example.com" }),
    /^--pooled-host is for --endpoint pooled\.$/,
  );
  refused(
    () => runtimeUrl(`mysql://owner:${OWNER_SECRET}@db.example.com/app`, { ...options, endpoint: "direct" }),
    /not a postgres/,
  );
});

test("DEP4: the password appears in the returned URL and nowhere else", () => {
  const built = runtimeUrl(NEON_DIRECT, { login: LOGIN, password: PASSWORD, endpoint: "pooled" });
  assert.equal(built.split(PASSWORD).length, 2, "exactly once, as the password");
  assert.ok(!built.includes(OWNER_SECRET), "the owner's password is gone");
  assert.ok(!built.includes("neondb_owner"), "and so is the owner's name");
});
