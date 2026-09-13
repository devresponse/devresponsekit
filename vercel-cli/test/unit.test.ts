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
  assert.ok(!redacted.includes("hunter2"));
  assert.ok(redacted.includes("db.example.com"));
  assert.ok(redacted.includes("appuser"), "the user is useful context and is not the secret");
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
