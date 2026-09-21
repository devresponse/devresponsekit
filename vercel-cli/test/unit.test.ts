import assert from "node:assert/strict";
import { test } from "node:test";

// Tests run against the BUILT output, so they exercise exactly what ships.
import { parseEnvFile } from "../dist/commands/env.js";
import { redactUrl } from "../dist/commands/release.js";
import {
  derivedValues,
  ENV_SPECS,
  FORBIDDEN_ON_VERCEL,
  REQUIRED_KEYS,
  specFor,
} from "../dist/lib/env-spec.js";
import { fingerprint, mask } from "../dist/lib/log.js";
import {
  generateAuthSecret,
  generateHandoffKeypair,
  generateOperatorSecret,
  isValidHandoffPrivateJwk,
} from "../dist/lib/secrets.js";

test("generated secrets satisfy the kit's own boot schema", () => {
  // The kit refuses anything under 32 chars at boot, so a generator that
  // produced a shorter value would fail the deployment, not this test.
  assert.ok(generateAuthSecret().length >= 32);
  assert.ok(generateOperatorSecret().length >= 32);
  assert.notEqual(generateAuthSecret(), generateAuthSecret(), "must not be deterministic");
});

test("the handoff keypair is a real Ed25519 private JWK", () => {
  const { privateJwk, publicJwk } = generateHandoffKeypair();
  const parsed = JSON.parse(privateJwk);
  assert.equal(parsed.kty, "OKP");
  assert.equal(parsed.crv, "Ed25519");
  assert.equal(typeof parsed.d, "string", "the private half must be present");
  assert.ok(isValidHandoffPrivateJwk(privateJwk));

  // The public half must NOT carry `d` — that is what gets published as JWKS.
  assert.equal(JSON.parse(publicJwk).d, undefined);
});

test("a truncated or wrong-curve key is rejected before it reaches Vercel", () => {
  assert.equal(isValidHandoffPrivateJwk("not json"), false);
  assert.equal(isValidHandoffPrivateJwk('{"kty":"OKP","crv":"Ed25519","x":"a"}'), false, "no private d");
  assert.equal(
    isValidHandoffPrivateJwk('{"kty":"EC","crv":"P-256","x":"a","d":"b"}'),
    false,
    "wrong key type",
  );
  assert.equal(
    isValidHandoffPrivateJwk(JSON.stringify(JSON.parse(generateHandoffKeypair().publicJwk))),
    false,
  );
});

test("the env spec validators mirror the kit's rules", () => {
  const authSecret = specFor("BETTER_AUTH_SECRET");
  assert.ok(authSecret?.validate);
  assert.notEqual(authSecret.validate!("short"), null, "under 32 chars must be rejected");
  assert.equal(authSecret.validate!(generateAuthSecret()), null);

  const dbUrl = specFor("DATABASE_URL");
  assert.notEqual(dbUrl?.validate!("mysql://x/y"), null);
  assert.equal(dbUrl?.validate!("postgresql://u:p@host:5432/db"), null);

  const suffixes = specFor("SSO_ALLOWED_ORIGIN_SUFFIXES");
  assert.equal(suffixes?.validate!("example.com,example.ca"), null);
  assert.notEqual(suffixes?.validate!("com"), null, "a bare public suffix must be rejected");
});

test("every required key is one the kit refuses to boot without", () => {
  assert.deepEqual(
    [...REQUIRED_KEYS].sort(),
    [
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_URL",
      "DATABASE_URL",
      "SSO_HANDOFF_APPLICATION_ID",
      "SSO_HANDOFF_AUDIENCE_PREFIX",
      "SSO_HANDOFF_ISSUER",
    ],
    "changing this set means the kit's env.ts changed — update both together",
  );
});

test("secrets are marked secret, so they are stored encrypted and never printed", () => {
  for (const key of ["BETTER_AUTH_SECRET", "DATABASE_URL", "SSO_HANDOFF_PRIVATE_KEY", "CRON_SECRET"]) {
    assert.equal(specFor(key)?.secret, true, `${key} must be treated as a secret`);
  }
  for (const key of ["BETTER_AUTH_URL", "NEXT_PUBLIC_APP_URL"]) {
    assert.equal(specFor(key)?.secret, false);
  }
});

test("derived values all come from the one origin", () => {
  const derived = derivedValues({
    origin: "https://app.example.com",
    appName: "Example",
    audiencePrefix: "devresponse-app",
    applicationId: "portal",
  });
  assert.equal(derived.BETTER_AUTH_URL, "https://app.example.com");
  assert.equal(derived.SSO_HANDOFF_ISSUER, "https://app.example.com", "satellites fetch JWKS from here");
  assert.equal(derived.NEXT_PUBLIC_PRODUCTION_HOST, "app.example.com");
  assert.equal(derived.NEXT_PUBLIC_APP_NAME, "Example");
});

test("development-only variables are refused on a deployment", () => {
  const keys = FORBIDDEN_ON_VERCEL.map((f) => f.key);
  assert.ok(keys.includes("AUTH_RATE_LIMIT_DISABLED"));
  assert.ok(keys.includes("SKIP_ENV_VALIDATION"));
  assert.ok(keys.includes("SEED_ADMIN_PASSWORD"));
  // Nothing may be both part of the contract and forbidden.
  for (const key of keys) {
    assert.equal(specFor(key), undefined, `${key} cannot be both required and forbidden`);
  }
});

test("mask never reveals any part of a value", () => {
  const secret = "super-secret-value-do-not-print-me";
  const masked = mask(secret);
  assert.ok(!masked.includes(secret));
  assert.ok(!masked.includes("super"));
  assert.match(masked, /34 chars/);
  assert.equal(mask(undefined).includes("unset"), true);
});

test("the fingerprint is stable, short and not the value", () => {
  const a = fingerprint("value-one");
  assert.equal(a, fingerprint("value-one"), "same input, same fingerprint");
  assert.notEqual(a, fingerprint("value-two"));
  assert.equal(a.length, 8);
});

test("redactUrl keeps the host but drops the password", () => {
  const redacted = redactUrl("postgresql://appuser:hunter2@db.example.com:5432/appdb");
  assert.ok(!redacted.includes("hunter2"), "the password must not survive");

  // Parse and compare the components exactly. A substring check would pass for
  // `evil.com/db.example.com` just as happily, which is the whole reason
  // `includes()` is the wrong tool for asserting anything about a URL.
  const parsed = new URL(redacted);
  assert.equal(parsed.hostname, "db.example.com");
  assert.equal(parsed.port, "5432");
  assert.equal(parsed.pathname, "/appdb");
  assert.equal(parsed.username, "appuser", "the user is useful context and is not the secret");
  assert.equal(parsed.password, "***", "the password is replaced by a marker, not passed through");

  assert.equal(redactUrl("not a url"), "(unparseable connection string)");
});

test("the .env reader handles the shapes a real file contains", () => {
  const parsed = parseEnvFile(
    [
      "# a comment",
      "",
      'QUOTED="value with spaces"',
      "SINGLE='single quoted'",
      "PLAIN=plain",
      "  SPACED = trimmed  ",
      "WITH_EQUALS=postgresql://u:p@h/db?opt=1&x=2",
      "EMPTY=",
      "not-a-pair",
    ].join("\n"),
  );
  assert.equal(parsed.QUOTED, "value with spaces");
  assert.equal(parsed.SINGLE, "single quoted");
  assert.equal(parsed.PLAIN, "plain");
  assert.equal(parsed.SPACED, "trimmed");
  assert.equal(parsed.WITH_EQUALS, "postgresql://u:p@h/db?opt=1&x=2", "values may contain =");
  assert.equal(parsed.EMPTY, "");
  assert.equal(parsed["not-a-pair"], undefined);
});

test("every spec carries the operator-facing text the commands print", () => {
  for (const spec of ENV_SPECS) {
    assert.ok(spec.comment.length > 0, `${spec.key} needs a comment for the Vercel dashboard`);
    assert.ok(spec.consequence.length > 0, `${spec.key} needs a consequence for env:check`);
    assert.ok(spec.comment.length <= 500, `${spec.key}'s comment exceeds Vercel's limit`);
  }
});

/* ================================================================== */
/*  Satellite support                                                  */
/* ================================================================== */

import {
  describeProfile,
  hostSitsUnder,
  isCookieDomainShaped,
  migrationPolicy,
  resolveProfile,
  satelliteConfigProblems,
} from "../dist/lib/target.js";
import {
  SATELLITE_ISSUER_ONLY,
  derivedValuesFor,
  envSpecsFor,
  mayGenerateAuthSecret,
  refusedFor,
  requiredKeysFor,
  satelliteEnvSpecs,
} from "../dist/lib/env-spec.js";
import { describeConsumer, isConsumerHealthy } from "../dist/lib/health.js";
import { suggestParentDomain } from "../dist/commands/init.js";

/** The config shape every `.drk-deploy.json` written before satellites has. */
const LEGACY_KIT_CONFIG = {
  projectId: "prj_legacy",
  teamId: "team_legacy",
  origin: "https://demo.example.com",
  appName: "DevResponse Enterprise",
  audiencePrefix: "devresponse-app",
  applicationId: "portal",
  kitRoot: "C:\\my\\repos\\devresponsekit",
};

function satelliteConfig(overrides: Record<string, unknown> = {}) {
  return {
    target: "satellite",
    satellite: {
      option: "standalone",
      appRoot: "C:\\my\\repos\\devresponseapps\\app-standalone",
      issuerOrigin: "https://demo.example.com",
      ...((overrides.satellite as Record<string, unknown>) ?? {}),
    },
    projectId: "prj_sat",
    origin: "https://app1.example.com",
    appName: "Satellite A",
    audiencePrefix: "devresponse-app",
    applicationId: "standalone",
    kitRoot: "C:\\my\\repos\\devresponsekit",
  };
}

function contextFor(config: ReturnType<typeof satelliteConfig> | typeof LEGACY_KIT_CONFIG) {
  return {
    profile: resolveProfile(config as never),
    origin: config.origin,
    appName: config.appName,
    audiencePrefix: config.audiencePrefix,
    applicationId: config.applicationId,
  };
}

test("a config with no target is the kit — the whole backward-compatibility guarantee", () => {
  const profile = resolveProfile(LEGACY_KIT_CONFIG as never);
  assert.equal(profile.kind, "kit");
  assert.equal(migrationPolicy(profile).allowed, true, "the kit owns the schema and must keep migrating");
  assert.deepEqual(
    envSpecsFor(contextFor(LEGACY_KIT_CONFIG) as never),
    ENV_SPECS,
    "the kit's spec list must be the same object it always was",
  );
  assert.deepEqual(
    derivedValuesFor(contextFor(LEGACY_KIT_CONFIG) as never),
    derivedValues({
      origin: LEGACY_KIT_CONFIG.origin,
      appName: LEGACY_KIT_CONFIG.appName,
      audiencePrefix: LEGACY_KIT_CONFIG.audiencePrefix,
      applicationId: LEGACY_KIT_CONFIG.applicationId,
    }),
  );
  assert.deepEqual(refusedFor(profile), [], "the kit IS the issuer — nothing issuer-only is refused");
  assert.equal(mayGenerateAuthSecret(profile), true);
});

test("a half-described satellite is refused rather than guessed at", () => {
  assert.throws(() => resolveProfile({ target: "satellite" } as never), /no `satellite` block/);
  assert.throws(
    () => resolveProfile({ ...LEGACY_KIT_CONFIG, satellite: { option: "shared" } } as never),
    /but `target` is "kit"/,
    "a satellite block under a kit target must not be read either way",
  );
  assert.throws(() => resolveProfile({ target: "primary" } as never), /Unknown deployment target/);
  assert.throws(
    () => resolveProfile(satelliteConfig({ satellite: { option: "sattelite" } }) as never),
    /Unknown satellite option/,
  );
  assert.throws(
    () => resolveProfile(satelliteConfig({ satellite: { issuerOrigin: "demo.example.com" } }) as never),
    /not an http\(s\) URL/,
    "the issuer must be an origin: its JWKS is fetched from it",
  );
});

test("a satellite defaults to NOT owning its database, and migrations fail closed", () => {
  const profile = resolveProfile(satelliteConfig() as never);
  assert.equal(profile.kind, "satellite");
  assert.equal(profile.database, "shared-with-kit", "absent must mean the safe reading, not the handy one");

  const policy = migrationPolicy(profile);
  assert.equal(policy.allowed, false);
  assert.match(policy.why, /does not own its schema/);
  assert.match(policy.hint ?? "", /--own-database/, "the escape must be named in the error");
});

test("a satellite that genuinely owns its database may migrate", () => {
  const profile = resolveProfile(satelliteConfig({ satellite: { database: "own" } }) as never);
  const policy = migrationPolicy(profile);
  assert.equal(policy.allowed, true);
  assert.match(policy.why, /owns its database/);
});

test("Option C is the shared-session one; A and B are not", () => {
  for (const option of ["standalone", "handoff"]) {
    const profile = resolveProfile(satelliteConfig({ satellite: { option } }) as never);
    assert.equal(profile.sharesSession, false, `${option} holds its own session`);
    assert.equal(mayGenerateAuthSecret(profile), true, `${option} may have a generated secret`);
  }
  const shared = resolveProfile(
    satelliteConfig({ satellite: { option: "shared", cookieDomain: ".example.com" } }) as never,
  );
  assert.equal(shared.sharesSession, true);
  assert.equal(
    mayGenerateAuthSecret(shared),
    false,
    "generating a secret for Option C breaks the shared session SILENTLY — the worst kind",
  );
  assert.match(describeProfile(shared), /shared session/);
});

test("the Option C secret must be supplied, and the refusal explains itself", () => {
  const context = contextFor(
    satelliteConfig({ satellite: { option: "shared", cookieDomain: ".example.com" } }),
  );
  const spec = envSpecsFor(context as never).find((s) => s.key === "BETTER_AUTH_SECRET");
  assert.ok(spec);
  assert.equal(spec.source, "supplied", "a `supplied` source is what stops env:sync generating it");
  assert.ok(spec.noValueHint, "the operator needs to be told WHY it cannot be generated");
  assert.match(spec.noValueHint, /byte-identical/);
  assert.match(spec.noValueHint, /kit/i);

  // A and B are the opposite: their secret is their own, so it is generated.
  const ownSecret = envSpecsFor(contextFor(satelliteConfig()) as never).find(
    (s) => s.key === "BETTER_AUTH_SECRET",
  );
  assert.equal(ownSecret?.source, "auth-secret");
  assert.equal(ownSecret?.noValueHint, undefined);
});

test("the issuer-only variables are REFUSED on every satellite", () => {
  const keys = SATELLITE_ISSUER_ONLY.map((f) => f.key);
  assert.ok(keys.includes("SSO_HANDOFF_PRIVATE_KEY"), "the one that turns a consumer into an issuer");
  assert.ok(keys.includes("SSO_HANDOFF_PREVIOUS_PRIVATE_KEY"), "the rotation half is a key too");
  assert.ok(keys.includes("SSO_ALLOWED_ORIGIN_SUFFIXES"));

  for (const option of ["standalone", "handoff", "shared"]) {
    const satellite = satelliteConfig({
      satellite: { option, ...(option === "shared" ? { cookieDomain: ".example.com" } : {}) },
    });
    const context = contextFor(satellite);
    const refused = refusedFor(context.profile).map((f) => f.key);
    for (const key of keys) {
      assert.ok(refused.includes(key), `${key} must be refused on a ${option} satellite`);
    }
    // And nothing refused may also be part of the contract — a variable cannot
    // be both required and forbidden.
    const specKeys = envSpecsFor(context as never).map((s) => s.key);
    for (const key of refused) {
      assert.ok(!specKeys.includes(key), `${key} cannot be both refused and part of the ${option} contract`);
    }
  }
});

test("COOKIE_DOMAIN is required for Option C and refused for A and B", () => {
  for (const option of ["standalone", "handoff"]) {
    const context = contextFor(satelliteConfig({ satellite: { option } }));
    assert.ok(
      refusedFor(context.profile).some((f) => f.key === "COOKIE_DOMAIN"),
      `${option} must refuse a parent-domain cookie — it would shadow its own host cookie`,
    );
    assert.ok(!requiredKeysFor(context as never).includes("COOKIE_DOMAIN"));
  }

  const shared = contextFor(
    satelliteConfig({ satellite: { option: "shared", cookieDomain: ".example.com" } }),
  );
  assert.ok(!refusedFor(shared.profile).some((f) => f.key === "COOKIE_DOMAIN"));
  assert.ok(
    requiredKeysFor(shared as never).includes("COOKIE_DOMAIN"),
    "Option C without it looks healthy and logs people out at random",
  );
});

test("the satellite's required set is the one its own env schema refuses to boot without", () => {
  assert.deepEqual(requiredKeysFor(contextFor(satelliteConfig()) as never).sort(), [
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    "DATABASE_URL",
    "SSO_HANDOFF_APPLICATION_ID",
    "SSO_HANDOFF_AUDIENCE_PREFIX",
    "SSO_HANDOFF_ISSUER",
  ]);
});

test("the retired SSO_HANDOFF_JWT_SECRET appears nowhere", () => {
  // The handoff is EdDSA + JWKS. A shared symmetric secret would have let every
  // consumer mint tokens, which is the property the current design removes.
  for (const option of ["standalone", "handoff", "shared"]) {
    const context = contextFor(
      satelliteConfig({
        satellite: { option, ...(option === "shared" ? { cookieDomain: ".example.com" } : {}) },
      }),
    );
    for (const spec of envSpecsFor(context as never)) {
      assert.notEqual(spec.key, "SSO_HANDOFF_JWT_SECRET");
    }
    for (const refused of refusedFor(context.profile)) {
      assert.notEqual(refused.key, "SSO_HANDOFF_JWT_SECRET");
    }
  }
  for (const spec of ENV_SPECS) assert.notEqual(spec.key, "SSO_HANDOFF_JWT_SECRET");
});

test("SSO_HANDOFF_ISSUER points at the kit — and says so when it does not", () => {
  const context = contextFor(satelliteConfig());
  const spec = envSpecsFor(context as never).find((s) => s.key === "SSO_HANDOFF_ISSUER");
  assert.ok(spec?.validate);
  assert.equal(spec.validate("https://demo.example.com"), null, "the kit's origin is correct");
  assert.match(
    spec.validate("https://app1.example.com") ?? "",
    /not this deployment's own/,
    "a satellite naming itself as issuer verifies against its own EMPTY key set",
  );
  assert.notEqual(spec.validate("demo.example.com"), null, "it must be an origin, not a bare host");

  // The derived value comes from the recorded issuer, never from the app's domain.
  const derived = derivedValuesFor(context as never);
  assert.equal(derived.SSO_HANDOFF_ISSUER, "https://demo.example.com");
  assert.equal(derived.BETTER_AUTH_URL, "https://app1.example.com", "its own origin, though");
  assert.equal(derived.NEXT_PUBLIC_PRODUCTION_HOST, "app1.example.com");
});

test("an Option C cookie domain the host does not sit under is refused", () => {
  const context = contextFor(
    satelliteConfig({ satellite: { option: "shared", cookieDomain: ".example.com" } }),
  );
  const spec = envSpecsFor(context as never).find((s) => s.key === "COOKIE_DOMAIN");
  assert.ok(spec?.validate);
  assert.equal(spec.validate(".example.com"), null);
  assert.equal(spec.validate("example.com"), null, "the leading dot is optional");
  assert.notEqual(spec.validate(".elsewhere.com"), null, "the browser would discard it outright");
  assert.notEqual(spec.validate(".com"), null, "a bare public suffix is not a site");

  const derived = derivedValuesFor(context as never);
  assert.equal(derived.COOKIE_DOMAIN, ".example.com");
  // A and B never derive one, even if one were somehow recorded.
  assert.equal(derivedValuesFor(contextFor(satelliteConfig()) as never).COOKIE_DOMAIN, undefined);
});

test("hostSitsUnder is exact-or-subdomain, not a substring match", () => {
  assert.equal(hostSitsUnder("app1.example.com", ".example.com"), true);
  assert.equal(hostSitsUnder("example.com", "example.com"), true);
  assert.equal(hostSitsUnder("app1.example.com:443", "example.com"), true, "a port is not part of the host");
  assert.equal(hostSitsUnder("evil-example.com", "example.com"), false, "the classic suffix-match hole");
  assert.equal(hostSitsUnder("example.com.attacker.net", "example.com"), false);
  assert.equal(isCookieDomainShaped(".ca"), false);
  assert.equal(isCookieDomainShaped(".example.ca"), true);
});

test("the satellite config problems are the ones that look fine until a user hits them", () => {
  const healthy = satelliteConfig({ satellite: { option: "standalone" } });
  assert.deepEqual(satelliteConfigProblems(contextFor(healthy) as never), []);

  const selfIssuing = contextFor(
    satelliteConfig({ satellite: { issuerOrigin: "https://app1.example.com" } }),
  );
  const problems = satelliteConfigProblems(selfIssuing as never);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].what, "SSO_HANDOFF_ISSUER");
  assert.match(problems[0].why, /own origin/);

  const noCookie = contextFor(satelliteConfig({ satellite: { option: "shared" } }));
  assert.ok(
    satelliteConfigProblems(noCookie as never).some((p) => p.what === "COOKIE_DOMAIN"),
    "Option C without a cookie domain is the silent logout bug",
  );

  const wrongCookie = contextFor(
    satelliteConfig({ satellite: { option: "shared", cookieDomain: ".elsewhere.com" } }),
  );
  assert.ok(satelliteConfigProblems(wrongCookie as never).some((p) => p.what === "COOKIE_DOMAIN"));
});

test("every satellite spec carries the text an operator actually reads", () => {
  for (const option of ["standalone", "handoff", "shared"]) {
    const profile = resolveProfile(
      satelliteConfig({
        satellite: { option, ...(option === "shared" ? { cookieDomain: ".example.com" } : {}) },
      }) as never,
    );
    const specs = satelliteEnvSpecs({
      profile,
      origin: "https://app1.example.com",
      appName: "Satellite",
      audiencePrefix: "devresponse-app",
      applicationId: option,
    } as never);
    for (const spec of specs) {
      assert.ok(spec.comment.length > 0, `${spec.key} needs a comment for the Vercel dashboard`);
      assert.ok(spec.comment.length <= 500, `${spec.key}'s comment exceeds Vercel's limit`);
      assert.ok(spec.consequence.length > 0, `${spec.key} needs a consequence for env:check`);
    }
    for (const key of ["BETTER_AUTH_SECRET", "DATABASE_URL", "CRON_SECRET", "METRICS_TOKEN"]) {
      assert.equal(specs.find((s) => s.key === key)?.secret, true, `${key} must be stored encrypted`);
    }
    for (const key of ["BETTER_AUTH_URL", "SSO_HANDOFF_ISSUER", "NEXT_PUBLIC_APP_URL"]) {
      assert.equal(specs.find((s) => s.key === key)?.secret, false);
    }
  }
});

test("a consumer is healthy when it REFUSES a garbage handoff token", () => {
  assert.equal(isConsumerHealthy({ health: 200, ready: 200, consume: 401 }), true);
  assert.equal(
    isConsumerHealthy({ health: 200, ready: 200, consume: 200 }),
    false,
    "accepting an unverifiable token is the opposite of healthy",
  );
  assert.equal(isConsumerHealthy({ health: 200, ready: 503, consume: 401 }), false);
  assert.equal(isConsumerHealthy({ health: 0, ready: 0, consume: 0 }), false);

  const lines = describeConsumer({ health: 200, ready: 200, consume: 500 }).join(" ");
  assert.match(lines, /SSO_HANDOFF_APPLICATION_ID/, "a 500 there means the audience is unconfigured");
  assert.match(
    describeConsumer({ health: 200, ready: 503, consume: 401 }).join(" "),
    /cannot reach its database/,
  );
});

test("the parent-domain suggestion is a suggestion, and is shaped like one", () => {
  assert.equal(suggestParentDomain("app3.example.com"), ".example.com");
  assert.equal(suggestParentDomain("example.com"), ".example.com", "nothing to strip");
  // Four labels happen to come out right — dropping the first leaves the
  // registrable domain.
  assert.equal(suggestParentDomain("app.example.co.uk"), ".example.co.uk");
  // THREE labels over a two-label public suffix is the naive case, and it is
  // wrong: `.co.uk` is a public suffix, so a browser discards a cookie scoped
  // to it. Without a public-suffix list there is no way to tell this apart
  // from `app.example.com`, which is precisely why the suggestion is shown to
  // a human to confirm and `--cookie-domain` is how a script states it.
  assert.equal(suggestParentDomain("app.co.uk"), ".co.uk", "wrong, and only a person can see that");
  assert.equal(isCookieDomainShaped(".co.uk"), true, "the shape check cannot catch it either");
});

/* ================================================================== */
/*  Satellite support: the review findings, pinned                     */
/* ================================================================== */

import { existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { assertSatelliteRoot, looksLikeSchemaOwner } from "../dist/lib/kit.js";
import { loadSuppliedValues } from "../dist/commands/env.js";

/** This package lives inside the kit, so the kit checkout is always at hand. */
const KIT_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The satellite repo is a sibling, and is not always checked out. */
const APPS_ROOT = resolvePath(KIT_ROOT, "..", "devresponseapps");

test("the kit checkout is REFUSED as a satellite — asserted against the real thing", () => {
  // The discriminator used to be `/api/sso/consume`, which the kit mounts too:
  // it is an issuer AND a consumer of its own handoffs. So the kit passed, and
  // `init` then offered to record it as owning its database — a config that
  // deploys the kit's source under the satellite contract.
  assert.ok(existsSync(join(KIT_ROOT, "src", "app", "api", "sso", "consume")), "premise of the bug");
  assert.equal(looksLikeSchemaOwner(KIT_ROOT), true, "the kit has migrations AND a real runner");
  assert.throws(() => assertSatelliteRoot(KIT_ROOT), /owns a database schema/);

  // And by path, for the case where a fork's scripts have drifted.
  assert.throws(
    () => assertSatelliteRoot(KIT_ROOT, KIT_ROOT),
    /is the KIT checkout/,
    "--app-root equal to --kit-root is never a satellite",
  );
});

test("a real satellite checkout still validates, and says the kit owns its schema", (t) => {
  if (!existsSync(APPS_ROOT)) {
    t.skip("devresponseapps is not checked out beside the kit");
    return;
  }
  for (const app of ["app-standalone", "app-handoff", "app-shared"]) {
    const root = join(APPS_ROOT, app);
    if (!existsSync(root)) continue;
    const checkout = assertSatelliteRoot(root, KIT_ROOT);
    assert.equal(checkout.name, app);
    assert.equal(
      checkout.databaseOwnedByKit,
      true,
      `${app} points its db:* scripts at the refusal stub — the app stating it does not own its schema`,
    );
    assert.equal(looksLikeSchemaOwner(root), false, `${app} carries 0001-0002 but no real runner`);
  }
});

test("the database variables follow database OWNERSHIP, not session sharing", () => {
  // `shared-with-kit` is the default for every option, so the common Option A
  // satellite has sharesSession === false and still runs on the kit's Postgres.
  // Branching on the session told it to give itself a database that `migrate`
  // would then refuse to populate.
  const onKitDb = contextFor(satelliteConfig({ satellite: { option: "standalone" } }));
  assert.equal(onKitDb.profile.database, "shared-with-kit");
  assert.equal(onKitDb.profile.sharesSession, false, "A does not share the session");

  const specs = envSpecsFor(onKitDb as never);
  const dbUrl = specs.find((s) => s.key === "DATABASE_URL");
  assert.match(dbUrl?.comment ?? "", /KIT's Postgres/, "an A/B satellite on the kit's database is told so");
  assert.ok(!/own Postgres/i.test(dbUrl?.comment ?? ""), "it must not be told to provision its own");
  assert.equal(
    specs.find((s) => s.key === "DB_SCHEMA")?.level,
    "recommended",
    "reading the primary's tables from the wrong schema is silent emptiness, not an error",
  );

  // A satellite that genuinely owns its database gets the opposite advice.
  const ownDb = contextFor(satelliteConfig({ satellite: { option: "standalone", database: "own" } }));
  const ownSpecs = envSpecsFor(ownDb as never);
  assert.match(ownSpecs.find((s) => s.key === "DATABASE_URL")?.comment ?? "", /OWN Postgres/);
  assert.equal(ownSpecs.find((s) => s.key === "DB_SCHEMA")?.level, "optional");
});

test("CRON_SECRET is never generated for a satellite on the kit's database", () => {
  // No satellite ships a `crons` entry — all three vercel.json files carry only
  // $schema and regions. On a shared database, arming /api/internal/outbox-drain
  // would let this app send the PRIMARY's mail and read the unredacted
  // delivery_payload. A generated secret is what arms it, and `source` is what
  // env:sync consults — not `level`.
  for (const option of ["standalone", "handoff", "shared"]) {
    const context = contextFor(
      satelliteConfig({
        satellite: { option, ...(option === "shared" ? { cookieDomain: ".example.com" } : {}) },
      }),
    );
    const cron = envSpecsFor(context as never).find((s) => s.key === "CRON_SECRET");
    assert.equal(cron?.source, "supplied", `${option} on the kit's database must not generate one`);
    assert.equal(cron?.level, "optional", "unset is the correct state, so env:check must not nag");
    assert.ok(!/vercel\.json ships/.test(cron?.comment ?? ""), "no satellite vercel.json ships a cron");
    assert.match(cron?.consequence ?? "", /correct state/);
  }

  // Own database: it may be scheduled externally, so the token is worth having.
  const own = contextFor(satelliteConfig({ satellite: { database: "own" } }));
  const cron = envSpecsFor(own as never).find((s) => s.key === "CRON_SECRET");
  assert.equal(cron?.source, "operator-secret");
  assert.equal(cron?.level, "recommended");
  assert.match(cron?.comment ?? "", /ships NO crons entry/, "still true: it has no schedule of its own");
});

test("the validators do not cite a satellite schema rule that does not exist", () => {
  // CRON_SECRET and METRICS_TOKEN are absent from the satellites'
  // serverEnvSchema — their routes read process.env directly.
  const specs = envSpecsFor(contextFor(satelliteConfig({ satellite: { database: "own" } })) as never);
  for (const key of ["CRON_SECRET", "METRICS_TOKEN"]) {
    const message = specs.find((s) => s.key === key)?.validate?.("short") ?? "";
    assert.notEqual(message, "", `${key} still has a length floor`);
    assert.ok(!/schema/.test(message), `${key} must not claim a schema rule the app does not have`);
  }
});

test("ADMIN_TRUSTED_ORIGINS does not tell a satellite to trust the kit", () => {
  // The satellite's trusted-origin list gates UNSAFE methods only. The handoff
  // is a GET redirect and the confirm POST is same-origin, so no cross-origin
  // request from the kit ever arrives — listing it only widens CSRF.
  const spec = envSpecsFor(contextFor(satelliteConfig()) as never).find(
    (s) => s.key === "ADMIN_TRUSTED_ORIGINS",
  );
  assert.equal(spec?.level, "optional", "unset is the correct default, so env:check must not nag");
  assert.ok(!/Include the kit/i.test(spec?.comment ?? ""));
});

test("a refused variable exported in the SHELL is seen, as the refusal hint promises", () => {
  // Refused keys are by definition absent from the spec list, so collecting
  // only spec keys left a shell-exported signing key invisible while the hint
  // told the operator to clear their shell.
  const context = contextFor(satelliteConfig());
  const specs = envSpecsFor(context as never);
  const refusedKeys = refusedFor(context.profile).map((f) => f.key);

  const previous = process.env.SSO_HANDOFF_PRIVATE_KEY;
  process.env.SSO_HANDOFF_PRIVATE_KEY = "a-stray-key-in-the-shell";
  try {
    assert.equal(
      loadSuppliedValues(specs, undefined, refusedKeys).SSO_HANDOFF_PRIVATE_KEY,
      "a-stray-key-in-the-shell",
    );
    assert.equal(
      loadSuppliedValues(specs, undefined).SSO_HANDOFF_PRIVATE_KEY,
      undefined,
      "without the refused keys it is invisible — the bug this pins",
    );
  } finally {
    if (previous === undefined) delete process.env.SSO_HANDOFF_PRIVATE_KEY;
    else process.env.SSO_HANDOFF_PRIVATE_KEY = previous;
  }
});
