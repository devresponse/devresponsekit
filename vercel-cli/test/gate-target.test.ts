import assert from "node:assert/strict";
import { test } from "node:test";

// Tests run against the BUILT output, so they exercise exactly what ships.
import {
  deploymentEventTexts,
  gateTargetUrl,
  ownerMatchesGateTarget,
  parseGateTargetLine,
} from "../dist/lib/gate-target.js";

/*
 * DEP4: `drk-deploy db:runtime-login` reads which database production uses
 * from the schema gate's `target` line in the serving deployment's build log
 * (DEP1's contract, pinned on the writing side by the kit's
 * tests/unit/deploy-gate.test.ts). These pin the reading side.
 */

const NEON_LINE =
  "[deploy-gate] target host=ep-a-pooler.x.neon.tech port=5432 database=neondb schema=auth user=neondb_owner runtime=owner";
/** The kit's own pinned example of an escaped database name and a non-owner. */
const ESCAPED_LINE =
  "[deploy-gate] target host=10.0.0.5 port=5444 database=my%20db schema=tenant_a user=auth_runtime runtime=non-owner";

test("DEP4: parses the gate's target line exactly", () => {
  assert.deepEqual(parseGateTargetLine([NEON_LINE]), {
    host: "ep-a-pooler.x.neon.tech",
    port: "5432",
    database: "neondb",
    schema: "auth",
    user: "neondb_owner",
    runtime: "owner",
  });
  assert.deepEqual(parseGateTargetLine([ESCAPED_LINE]), {
    host: "10.0.0.5",
    port: "5444",
    database: "my%20db",
    schema: "tenant_a",
    user: "auth_runtime",
    runtime: "non-owner",
  });
  // A URL with no database prints `database=`, which the writer's pin allows.
  assert.equal(parseGateTargetLine([NEON_LINE.replace("database=neondb", "database=")])?.database, "");
  // Windows line endings, and lines inside one multi-line event.
  assert.equal(parseGateTargetLine([`${NEON_LINE}\r`])?.user, "neondb_owner");
  assert.equal(parseGateTargetLine([`building…\n${NEON_LINE}\n[deploy-gate] PASS`])?.user, "neondb_owner");
  assert.equal(parseGateTargetLine([]), null);
  assert.equal(parseGateTargetLine(["[deploy-gate] skip prebuilt-after-migrate"]), null);
});

test("DEP4: the LAST target line wins, across events and within one", () => {
  const later = NEON_LINE.replace(
    "user=neondb_owner runtime=owner",
    "user=auth_app_202610011234 runtime=non-owner",
  );
  assert.equal(parseGateTargetLine([NEON_LINE, "noise", later])?.user, "auth_app_202610011234");
  assert.equal(parseGateTargetLine([`${later}\n${NEON_LINE}`])?.user, "neondb_owner");
});

test("DEP4: a malformed line is ignored, never read in part", () => {
  const malformed = [
    NEON_LINE.replace(" runtime=owner", ""),
    `${NEON_LINE} extra`,
    `prefix ${NEON_LINE}`,
    NEON_LINE.replace("runtime=owner", "runtime=superuser"),
    NEON_LINE.replace("port=5432", "port=x"),
    NEON_LINE.replace(" port=5432", ""),
    NEON_LINE.replace("[deploy-gate]", "[gate]"),
    NEON_LINE.replace("schema=auth", "schema="),
    NEON_LINE.replace("user=neondb_owner", "user=two words"),
  ];
  for (const line of malformed) assert.equal(parseGateTargetLine([line]), null, line);
  // Ignored, not fatal: a good line before or after still counts.
  assert.equal(parseGateTargetLine([NEON_LINE, ...malformed])?.user, "neondb_owner");
});

test("DEP4: the owner's direct URL matches the gate's pooled host, and nothing else", () => {
  const gate = parseGateTargetLine([NEON_LINE])!;
  const owner = (url: string) => ownerMatchesGateTarget(new URL(url), gate);
  // Neon's `-pooler` is the one difference allowed, on either side.
  assert.equal(owner("postgresql://neondb_owner:pw@ep-a.x.neon.tech/neondb?sslmode=require"), true);
  assert.equal(owner("postgresql://neondb_owner:pw@EP-A.x.neon.tech:5432/neondb"), true);
  assert.equal(
    ownerMatchesGateTarget(
      new URL("postgresql://neondb_owner:pw@ep-a.x.neon.tech/neondb"),
      parseGateTargetLine([NEON_LINE.replace("ep-a-pooler", "ep-a")])!,
    ),
    true,
  );
  assert.equal(owner("postgresql://neondb_owner:pw@ep-b.x.neon.tech/neondb"), false, "another host");
  assert.equal(owner("postgresql://neondb_owner:pw@ep-a.x.neon.tech/otherdb"), false, "another database");
  assert.equal(owner("postgresql://neondb_owner:pw@ep-a.x.neon.tech:5433/neondb"), false, "another port");

  // The database as the URL writes it, percent-escapes and all.
  const escaped = parseGateTargetLine([ESCAPED_LINE])!;
  assert.equal(ownerMatchesGateTarget(new URL("postgres://owner:pw@10.0.0.5:5444/my%20db"), escaped), true);
  assert.equal(ownerMatchesGateTarget(new URL("postgres://owner:pw@10.0.0.5:5444/my_db"), escaped), false);

  // No database is libpq's default, the user's own name, on both sides.
  const bare = parseGateTargetLine([NEON_LINE.replace("database=neondb", "database=")])!;
  assert.equal(gateTargetUrl(bare)?.pathname, "/");
  assert.equal(ownerMatchesGateTarget(new URL("postgresql://neondb_owner:pw@ep-a.x.neon.tech/"), bare), true);
  assert.equal(
    ownerMatchesGateTarget(new URL("postgresql://neondb_owner:pw@ep-a.x.neon.tech/neondb"), bare),
    false,
  );
});

test("DEP4: every line of text in a getDeploymentEvents answer, in both event shapes", () => {
  assert.deepEqual(
    deploymentEventTexts([
      { type: "stdout", created: 1, text: "first" },
      null,
      { type: "stdout", created: 2, payload: { text: "second", id: "x" } },
      { type: "deployment-state", created: 3, payload: {} },
      { type: "stderr", created: 4, text: NEON_LINE },
    ]),
    ["first", "second", NEON_LINE],
  );
  assert.deepEqual(deploymentEventTexts({ type: "stdout", text: "only" }), ["only"]);
  assert.deepEqual(deploymentEventTexts(undefined), []);
});
