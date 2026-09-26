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

  // F-27: the kit refuses this sender at boot once EMAIL_PROVIDER is set, and
  // it is what `.env.example` ships, so `env:sync --force` must not write it.
  const from = specFor("EMAIL_FROM");
  assert.ok(from?.validate);
  assert.match(from.validate!("DevResponse <no-reply@localhost>") ?? "", /localhost is reserved/);
  assert.equal(from.validate!("DevResponse <no-reply@devresponse.ca>"), null);
  assert.equal(from.validate!("no-reply@devresponse.ca"), null);
});

test("every required key is one the kit refuses to boot without", () => {
  // A snapshot, so a change to the set is deliberate here too. What ties it to
  // the kit is the kit's own suite, which imports both this spec and
  // src/lib/env.ts and derives the set from the schema
  // (tests/unit/drk-deploy-required-keys.test.ts, F-45): this package cannot
  // import the kit across its `rootDir`.
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

test("F-144: the .env reader drops inline comments and `export` the way the kit's own reader does", () => {
  const SECRET = "0123456789abcdef0123456789abcdef";
  const JWK = '{"kty":"OKP","crv":"Ed25519","x":"a","d":"b"}';
  const parsed = parseEnvFile(
    [
      `BETTER_AUTH_SECRET=${SECRET} # copied from the kit`,
      'QUOTED_THEN_COMMENT="value with spaces" # a note',
      `export EXPORTED=${SECRET}`,
      "HASH=abc#def",
      'QUOTED_HASH="abc#def"',
      // How `vercel pull` writes a JSON value, and the shape the kit's
      // .env.example invites: unescaped quotes inside double quotes.
      `SSO_HANDOFF_PRIVATE_KEY="${JWK}"`,
      'ESCAPED="line1\\nline2"',
      "WINDOWS=crlf\r",
    ].join("\n"),
  );
  assert.equal(parsed.BETTER_AUTH_SECRET, SECRET, "a trailing comment is not part of the secret");
  assert.equal(parsed.QUOTED_THEN_COMMENT, "value with spaces", "nor of a quoted value");
  assert.equal(parsed.EXPORTED, SECRET, "`export KEY=` is the key KEY");
  assert.equal(parsed["export EXPORTED"], undefined);
  assert.equal(parsed.HASH, "abc", "an unquoted # starts a comment, as it does for @next/env");
  assert.equal(parsed.QUOTED_HASH, "abc#def", "quoting keeps it");
  assert.equal(parsed.SSO_HANDOFF_PRIVATE_KEY, JWK, "node:util parseEnv would stop at the first inner quote");
  assert.equal(parsed.ESCAPED, "line1\nline2", "vercel pull escapes a newline as \\n");
  assert.equal(parsed.WINDOWS, "crlf");
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
import {
  describe as describeHealth,
  describeConsumer,
  isConsumerHealthy,
  isHealthy,
  probe,
} from "../dist/lib/health.js";
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

test("each kit probe signs in with its own address, so nobody can spend its per-account budget", async () => {
  // F-55 budgets /sign-in/email per submitted address. A fixed probe address,
  // readable in this public CLI, could be kept at 429 by anyone, and every
  // release would then fail its probe and roll back.
  const saved = globalThis.fetch;
  const emails: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname !== "/api/auth/sign-in/email") return new Response("", { status: 200 });
    emails.push((JSON.parse(String(init?.body)) as { email: string }).email);
    return new Response("", { status: 401 });
  }) as typeof fetch;
  try {
    assert.equal(isHealthy(await probe("https://demo.example.com")), true);
    await probe("https://demo.example.com");
  } finally {
    globalThis.fetch = saved;
  }
  assert.equal(emails.length, 2);
  assert.notEqual(emails[0], emails[1]);
  for (const email of emails) {
    assert.match(email, /^drk-deploy-probe-[0-9a-f-]{36}@invalid\.example$/);
  }

  assert.match(
    describeHealth({ health: 200, ready: 200, readyStatus: "ready", signIn: 429 }).join(" "),
    /rate-limited this probe/,
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

/* ================================================================== */
/*  F-24: an A/B satellite is contained only off the kit's database    */
/*  and outside its cookie domain, and the CLI says so                 */
/* ================================================================== */

import { readFileSync } from "node:fs";

import { reportContainment } from "../dist/commands/env.js";
import { setQuiet } from "../dist/lib/log.js";
import {
  CONTAINMENT_DOC,
  SATELLITE_OPTION_SUMMARIES,
  containmentWarnings,
  sharedParentDomain,
} from "../dist/lib/target.js";

/** A satellite on a registrable domain the kit (demo.example.com) does not share. */
const OFF_DOMAIN = "https://app1.example.net";

function warningsFor(overrides: Record<string, unknown>, origin: string) {
  const profile = resolveProfile(satelliteConfig({ satellite: overrides }) as never);
  return containmentWarnings({ profile, origin } as never);
}

test("an A or B satellite on the kit's database is warned it is NOT contained", () => {
  for (const option of ["standalone", "handoff"]) {
    // The default: no `database` recorded means the kit's.
    const warnings = warningsFor({ option }, OFF_DOMAIN);
    assert.deepEqual(
      warnings.map((w) => w.what),
      ["database"],
      `${option} on the kit's database must be told, whatever its host`,
    );
    assert.match(warnings[0].why, /KIT's database/);
    assert.match(warnings[0].why, /auth tables/, "the consequence is named, not just the fact");
    assert.match(warnings[0].why, /Option C/, "same-DB A/B is security-equivalent to C, and says so");
    assert.match(warnings[0].why, /not contained/);
    // The boundary is the credential. Roles are cluster-wide and CONNECT is
    // PUBLIC by default, so "a separate database" reached as the kit's role
    // is the kit's database one URL edit away.
    assert.match(warnings[0].hint, /ROLE with no privileges on the kit's schema/);
    assert.match(
      warnings[0].hint,
      /new database under the kit's role is no boundary/,
      "a separate database alone is not the fix",
    );
    assert.match(
      warnings[0].hint,
      /role made in the Neon console .*neon_superuser/,
      "on Neon a console-made role writes every table in the project, so a dedicated role must be made with SQL",
    );
    assert.match(warnings[0].hint, /search_path, not a boundary/, "DB_SCHEMA alone is not the fix");
    assert.match(warnings[0].hint, /--own-database/);
  }
});

test("a satellite recorded as `database: own`, off the kit's domain, gets no warning: `own` is taken at its word", () => {
  // The CLI never sees the value of DATABASE_URL, so it cannot tell its own
  // role from the kit's under another database name. It warns about neither,
  // and says where the answer is given that `own` must mean the role too.
  assert.deepEqual(warningsFor({ option: "standalone", database: "own" }, OFF_DOMAIN), []);
  assert.deepEqual(warningsFor({ option: "handoff", database: "own" }, OFF_DOMAIN), []);

  const ownDb = contextFor(satelliteConfig({ satellite: { option: "standalone", database: "own" } }));
  const comment = envSpecsFor(ownDb as never).find((s) => s.key === "DATABASE_URL")?.comment ?? "";
  assert.match(
    comment,
    /OWN role/,
    "the own-database DATABASE_URL comment asks for the role, not only the database",
  );
  assert.match(comment, /kit's role with another database name/, "and names the trap");
  assert.ok(comment.length <= 500, "Vercel keeps 500 characters of a comment");
});

test("an A or B satellite that shares a parent domain with the kit is warned about the cookie", () => {
  // Own database, so the cookie is the only thing left to warn about. The kit
  // is demo.example.com; app1.example.com sits under the `.example.com` an
  // Option C fleet would set as COOKIE_DOMAIN.
  const warnings = warningsFor({ option: "standalone", database: "own" }, "https://app1.example.com");
  assert.deepEqual(
    warnings.map((w) => w.what),
    ["cookie domain"],
  );
  assert.equal(
    warnings[0].why.split(". ")[0],
    "this host and the kit (demo.example.com) both sit under `example.com`",
    "names the kit and the domain its cookie would be scoped to",
  );
  assert.match(warnings[0].why, /replay it on the kit/, "the consequence is named");
  assert.match(warnings[0].why, /prefix stops shadowing, not theft/, "a cookie prefix is not the fix");
  assert.match(warnings[0].hint, /different registrable domain/);

  // Both facts at once: the live demo fleet's shape (the kit's database, and a
  // subdomain of the kit's own parent domain).
  const both = containmentWarnings({
    profile: resolveProfile(
      satelliteConfig({ satellite: { issuerOrigin: "https://demo.devresponse.ca" } }) as never,
    ),
    origin: "https://demo-standalone.devresponse.ca",
  } as never);
  assert.deepEqual(
    both.map((w) => w.what),
    ["database", "cookie domain"],
  );
});

test("Option C is never warned: it shares the kit's security domain by definition", () => {
  assert.deepEqual(
    warningsFor({ option: "shared", cookieDomain: ".example.com" }, "https://app3.example.com"),
    [],
  );
});

test("the containment warnings are warnings: a healthy config still has no problems", () => {
  // `deploy` refuses on problems. Every satellite deployed so far runs on the
  // kit's database; it must keep deploying while being told it is not
  // contained.
  // app1.example.com on the kit's database, beside demo.example.com: both warnings.
  const context = contextFor(satelliteConfig({ satellite: { option: "standalone" } }));
  assert.deepEqual(satelliteConfigProblems(context as never), []);
  assert.deepEqual(
    containmentWarnings(context as never).map((w) => w.what),
    ["database", "cookie domain"],
  );
  assert.equal(migrationPolicy(context.profile).allowed, false, "and the migration refusal is unchanged");
});

test("sharedParentDomain finds the domain a cookie could span, and nothing a cookie cannot", () => {
  assert.equal(sharedParentDomain("app1.example.com", "demo.example.com"), "example.com");
  assert.equal(
    sharedParentDomain("demo-handoff.devresponse.ca:443", "demo.devresponse.ca"),
    "devresponse.ca",
  );
  assert.equal(sharedParentDomain("app.demo.example.com", "demo.example.com"), "demo.example.com");
  assert.equal(
    sharedParentDomain("App1.Example.com", "demo.example.com."),
    "example.com",
    "case and a trailing dot",
  );
  assert.equal(sharedParentDomain("app.example.co.uk", "demo.example.co.uk"), "example.co.uk");
  assert.equal(sharedParentDomain("example.com", "example.net"), null, "nothing but a TLD in common");
  assert.equal(sharedParentDomain("app1.example.net", "demo.example.com"), null);
  assert.equal(sharedParentDomain("evil-example.com", "example.com"), null, "labels, not substrings");
  assert.equal(
    sharedParentDomain("devresponse-standalone.vercel.app", "demo.vercel.app"),
    null,
    "vercel.app is a public suffix: no cookie spans two projects on it",
  );
  assert.equal(sharedParentDomain("10.0.0.1", "11.0.0.1"), null, "an IP literal has no parent domain");
  assert.equal(sharedParentDomain("[::1]:3000", "[::2]:3000"), null, "nor does an IPv6 one");

  // Cookies are not scoped by port: one host on two ports shares every
  // cookie, host-only ones included, even where there is no parent domain.
  assert.equal(sharedParentDomain("[::1]:3000", "[::1]:3001"), "[::1]");
  assert.equal(sharedParentDomain("localhost:3001", "localhost:3000"), "localhost");
  assert.equal(sharedParentDomain("127.0.0.1:3001", "127.0.0.1:3000"), "127.0.0.1");
  assert.equal(sharedParentDomain("Demo.Example.com:8443", "demo.example.com."), "demo.example.com");
});

test("an A or B satellite on the kit's own host is warned even without a COOKIE_DOMAIN", () => {
  // One host, two ports: the kit's default host-only cookie arrives here too,
  // so the warning must not hinge on COOKIE_DOMAIN the way the parent-domain
  // one does.
  const warnings = containmentWarnings({
    profile: resolveProfile(
      satelliteConfig({ satellite: { database: "own", issuerOrigin: "http://localhost:3000" } }) as never,
    ),
    origin: "http://localhost:3001",
  } as never);
  assert.deepEqual(
    warnings.map((w) => w.what),
    ["cookie domain"],
  );
  assert.match(warnings[0].why, /share one host \(`localhost`\)/);
  assert.match(warnings[0].why, /not scoped by port/);
  assert.match(warnings[0].why, /whether or not the kit sets COOKIE_DOMAIN/);
  assert.doesNotMatch(warnings[0].why, /If the kit's COOKIE_DOMAIN is/, "not conditional on the setting");
  assert.match(warnings[0].hint, /host of its own/);
});

test("init's option list no longer promises A a database the default does not give it", () => {
  for (const option of ["standalone", "handoff"] as const) {
    const profile = resolveProfile(satelliteConfig({ satellite: { option } }) as never);
    assert.equal(profile.kind === "satellite" && profile.database, "shared-with-kit", "the default");
    assert.ok(
      !/own database/i.test(SATELLITE_OPTION_SUMMARIES[option]),
      `${option}'s summary must not claim its own database while init defaults it to the kit's`,
    );
  }
  assert.match(SATELLITE_OPTION_SUMMARIES.shared, /KIT's database/);
});

test("the containment warning survives --quiet and points at a heading that exists", () => {
  const profile = resolveProfile(satelliteConfig() as never);
  const written: string[] = [];
  const original = process.stderr.write;
  setQuiet(true);
  process.stderr.write = ((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.equal(reportContainment(profile, OFF_DOMAIN), 1);
    assert.equal(reportContainment(resolveProfile(LEGACY_KIT_CONFIG as never), OFF_DOMAIN), 0, "the kit");
  } finally {
    process.stderr.write = original;
    setQuiet(false);
  }
  const output = written.join("");
  assert.match(output, /Not contained \(database\)/, "a warning, on stderr, even under --quiet");
  assert.ok(output.includes(CONTAINMENT_DOC), "and it links the doc section");

  // The link is only worth printing if the section is there: the GitHub-style
  // slug of every heading in the real document, as lychee resolves it.
  const [file, anchor] = CONTAINMENT_DOC.split("#");
  const doc = readFileSync(join(KIT_ROOT, file!), "utf8");
  const slugs = [...doc.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) =>
    m[1]!
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-"),
  );
  assert.ok(slugs.includes(anchor!), `${file} has no heading for #${anchor}`);
});

/* ================================================================== */
/*  F-143 / F-145: secrets stay off the screen, and pnpm runs from a   */
/*  path with a space in it                                            */
/* ================================================================== */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { ask, login } from "../dist/commands/init.js";
import { inheritedEnv, pnpmCommand, run } from "../dist/lib/exec.js";

/**
 * Stands in for the Vercel API, refusing every token so that nothing is
 * saved: these tests are about the prompt, and about the token reaching the
 * client intact. Returns the Authorization header of the last request.
 */
function refusingVercel(): { authorization: () => string; restore: () => void } {
  let authorization = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    authorization = new Request(input, init).headers.get("authorization") ?? "";
    return new Response(JSON.stringify({ error: { code: "forbidden", message: "Not authorized" } }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    authorization: () => authorization,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

test("F-143: login reads the token without echoing it, at a terminal or from a pipe", async () => {
  const TOKEN_TYPED = "vcp_typed-token-never-shown";
  const vercel = refusingVercel();
  setQuiet(true);
  try {
    for (const terminal of [true, false]) {
      const input = Object.assign(new PassThrough(), terminal ? { isTTY: true } : {});
      let shown = "";
      const output = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          shown += chunk.toString();
          callback();
        },
      });
      const pending = login({}, { input, output });
      // At a terminal readline echoes each keystroke itself; Enter is "\r".
      input.write(`${TOKEN_TYPED}${terminal ? "\r" : "\n"}`);
      await assert.rejects(pending, /Could not authenticate/);
      const mode = terminal ? "at a terminal" : "from a pipe";
      assert.match(shown, /Paste a Vercel access token/, `the prompt is shown ${mode}`);
      assert.ok(!shown.includes(TOKEN_TYPED), `the token is not echoed ${mode}: ${JSON.stringify(shown)}`);
      assert.equal(
        vercel.authorization(),
        `Bearer ${TOKEN_TYPED}`,
        `the typed token is the one verified ${mode}`,
      );
    }
  } finally {
    vercel.restore();
    setQuiet(false);
  }
});

test(
  "F-143: a piped token needs no trailing newline, and an empty pipe is refused by name",
  // A prompt that never settles leaves nothing to keep the process alive:
  // Node exits 13 ("unsettled top-level await"), so fail rather than wait.
  { timeout: 10_000 },
  async () => {
    const vercel = refusingVercel();
    setQuiet(true);
    try {
      // Notepad and `Set-Content -NoNewline` save the token with no newline
      // after it, and `drk-deploy login < token.txt` then ends on that line.
      const TOKEN = "vcp_saved-with-no-newline";
      let input = new PassThrough();
      let pending = login({}, { input, output: new PassThrough() });
      input.end(TOKEN);
      await assert.rejects(pending, /Could not authenticate/);
      assert.equal(vercel.authorization(), `Bearer ${TOKEN}`, "the unterminated line is the token");

      // `drk-deploy login < NUL`: the CLI's own refusal, not a silent exit.
      input = new PassThrough();
      pending = login({}, { input, output: new PassThrough() });
      input.end();
      await assert.rejects(pending, /No token supplied/);
    } finally {
      vercel.restore();
      setQuiet(false);
    }
  },
);

test(
  "F-143: init's prompts settle when their input ends, and never take a default nobody chose",
  { timeout: 10_000 },
  async () => {
    const output = new PassThrough();
    let input = new PassThrough();
    let pending = ask("Project name or id", undefined, { input, output });
    input.end("my-app");
    assert.equal(await pending, "my-app", "an unterminated last line is the answer");

    input = new PassThrough();
    pending = ask("Production domain", "app.example.com", { input, output });
    input.end("\n");
    assert.equal(await pending, "app.example.com", "a blank line is Enter, which takes the default");

    // Ended input is not Enter: the cookie domain is "never guessed for you".
    input = new PassThrough();
    pending = ask("Cookie domain", ".example.com", { input, output });
    input.end();
    await assert.rejects(pending, /No answer to "Cookie domain": the input closed first/);
    // Nor is an input an earlier prompt already read to its end.
    await assert.rejects(
      ask("Satellite option", "standalone", { input, output }),
      /No answer to "Satellite option"/,
    );
  },
);

test(
  "F-145: a pnpm .cmd shim under a folder with a space in it still runs",
  { skip: process.platform !== "win32" && "only Windows runs pnpm through a .cmd shim and cmd.exe" },
  async () => {
    // A corepack install puts its shim at C:\Program Files\nodejs\pnpm.cmd,
    // with no pnpm.cjs beside it, so the shim itself is what runs.
    const dir = mkdtempSync(join(tmpdir(), "drk deploy pnpm "));
    const path = process.env.PATH;
    try {
      writeFileSync(join(dir, "pnpm.cmd"), "@echo off\r\necho pnpm-shim %*\r\n");
      process.env.PATH = `${dir}${delimiter}${path ?? ""}`;
      const pnpm = pnpmCommand();
      assert.equal(pnpm.command, join(dir, "pnpm.cmd"), "the shim is the command, spaces and all");
      // What `doctor` runs, and what `migrate` runs through runPnpm.
      const result = await run(pnpm.command, [...pnpm.prefix, "--version"], { cwd: dir, capture: true });
      assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
      assert.equal(result.stdout.trim(), "pnpm-shim --version");
    } finally {
      process.env.PATH = path;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

/* ================================================================== */
/*  F-139: a child inherits an allow-list, never the Vercel token      */
/* ================================================================== */

/** A shell as an operator's (or a CI job's) looks: the toolchain's variables, and secrets. */
const OPERATOR_SHELL: Record<string, string> = {
  // What the toolchain needs, in the spellings Windows and POSIX shells use.
  Path: "C:\tools;C:\Windows\system32",
  SystemRoot: "C:\Windows",
  ComSpec: "C:\Windows\system32\cmd.exe",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  USERPROFILE: "C:\Users\operator",
  LOCALAPPDATA: "C:\Users\operator\AppData\Local",
  HOME: "/home/operator",
  TEMP: "C:\Temp",
  https_proxy: "http://proxy.internal:8080",
  NODE_EXTRA_CA_CERTS: "/etc/ssl/corporate.pem",
  NODE_OPTIONS: "--max-old-space-size=8192",
  npm_config_registry: "https://registry.internal/",
  COREPACK_HOME: "/home/operator/.cache/node/corepack",
  LC_ALL: "C.UTF-8",
  XDG_CACHE_HOME: "/home/operator/.cache",
  CI: "true",
  // What no child may inherit: credentials, and values that would beat
  // production's own in a build.
  VERCEL_TOKEN: "vcp_account-wide-token",
  vercel_token: "vcp_lower-case-token",
  NOW_TOKEN: "legacy-token",
  PRODUCTION_DIRECT_DATABASE_URL: "postgresql://owner:prod-password@ep-prod.neon.tech/neondb",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/devresponse",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "a-local-secret-that-is-long-enough-to-pass",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  GITHUB_TOKEN: "ghs_token",
  // Registry logins ride in the npm/pnpm/corepack families the toolchain's
  // settings come from, and stay behind all the same.
  COREPACK_NPM_TOKEN: "npm_corepack-token",
  COREPACK_NPM_PASSWORD: "corepack-password",
  npm_config__authToken: "npm_legacy-token",
  "npm_config_//registry.internal/:_authToken": "npm_registry-token",
  pnpm_config__password: "cGFzc3dvcmQ=",
  VERCEL_ORG_ID: "team_other",
  NODE_ENV: "production",
};

const TOOLCHAIN = [
  "Path",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
  "LOCALAPPDATA",
  "HOME",
  "TEMP",
  "https_proxy",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "npm_config_registry",
  "COREPACK_HOME",
  "LC_ALL",
  "XDG_CACHE_HOME",
  "CI",
];

test("F-139: a child inherits what runs the toolchain, and no credential or application value", () => {
  const inherited = inheritedEnv(OPERATOR_SHELL);
  assert.deepEqual(Object.keys(inherited).sort(), [...TOOLCHAIN].sort());
  for (const key of TOOLCHAIN) assert.equal(inherited[key], OPERATOR_SHELL[key], `${key} is passed as it is`);

  // The migration runners keep the rest of the shell, but never the token,
  // in any casing or under its legacy name.
  const whole = inheritedEnv(OPERATOR_SHELL, true);
  assert.deepEqual(
    Object.keys(whole).sort(),
    Object.keys(OPERATOR_SHELL)
      .filter((key) => !["VERCEL_TOKEN", "vercel_token", "NOW_TOKEN"].includes(key))
      .sort(),
  );
});

test("F-139: run hands a child the allow-list plus what the caller names, never the shell", async () => {
  const shell = {
    DRK_TEST_SHELL_SECRET: "exported-in-the-shell",
    VERCEL_TOKEN: "vcp_exported-by-ci",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  };
  const saved = Object.fromEntries(Object.keys(shell).map((key) => [key, process.env[key]]));
  Object.assign(process.env, shell);
  // The child reports its whole environment: only the spawned process shows
  // what actually reached it.
  const seen = async (options: { env?: Record<string, string | undefined>; inheritShell?: boolean }) => {
    const result = await run(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], {
      cwd: tmpdir(),
      capture: true,
      ...options,
    });
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout) as Record<string, string>;
  };
  const has = (env: Record<string, string>, name: string) =>
    Object.keys(env).some((key) => key.toUpperCase() === name);
  try {
    const child = await seen({ env: { HANDED_ON_PURPOSE: "yes" } });
    for (const key of Object.keys(shell)) assert.equal(has(child, key), false, `${key} stays in the shell`);
    assert.equal(child.HANDED_ON_PURPOSE, "yes", "what the caller names reaches the child");
    assert.ok(has(child, "PATH"), "the toolchain's variables are inherited");

    // A `vercel` step that needs the token is handed it by name.
    assert.equal((await seen({ env: { VERCEL_TOKEN: "vcp_handed" } })).VERCEL_TOKEN, "vcp_handed");

    // The migration runners keep the shell, still without the token.
    const runner = await seen({ inheritShell: true });
    assert.equal(runner.DRK_TEST_SHELL_SECRET, "exported-in-the-shell");
    assert.equal(has(runner, "VERCEL_TOKEN"), false, "the token never rides along with the shell");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
