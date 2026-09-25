import { describe, expect, it } from "vitest";
import { invalidServerEnvKeys } from "@/lib/env";
// drk-deploy cannot import the kit across its package boundary (its tsconfig
// `rootDir` is its own `src`), so its environment contract is a hand-kept copy
// of this schema's required set. This suite imports both halves (F-45).
import {
  derivedValues,
  ENV_SPECS,
  REQUIRED_KEYS,
  type EnvVarSpec,
} from "../../vercel-cli/src/lib/env-spec";
import { generateAuthSecret } from "../../vercel-cli/src/lib/secrets";

/**
 * drk-deploy's required set IS the kit's (F-45, review #123 / #189).
 *
 * `env:sync` writes, and `env:check` / the `deploy` preflight demand, exactly
 * the keys `vercel-cli/src/lib/env-spec.ts` marks `required`. That list used
 * to be pinned only by a hardcoded copy in the CLI's own suite, which nothing
 * tied to `src/lib/env.ts`: a new required key here would boot-fail the next
 * production deployment while `env:check` reported the project healthy. The
 * required set is DERIVED here from the kit's schema instead of restated, in
 * both directions:
 *
 * - SUFFICIENT: the values drk-deploy would write for its required keys, and
 *   nothing else, boot the kit in production. A key env.ts starts requiring
 *   is named by `invalidServerEnvKeys` until env-spec requires it too.
 * - NECESSARY: dropping any one of them fails the kit's boot, naming that key.
 *   A key env-spec calls required that the kit can boot without would make
 *   `deploy` refuse a healthy project.
 */

const ORIGIN = "https://app.example.com";

/**
 * The value drk-deploy writes for a required spec, by the spec's own `source`:
 * what a first `env:sync` would put on a fresh project.
 */
function valueFor(spec: EnvVarSpec): string | undefined {
  switch (spec.source) {
    case "auth-secret":
      return generateAuthSecret();
    case "derived":
      return derivedValues({
        origin: ORIGIN,
        appName: "Example",
        audiencePrefix: "devresponse-app",
        applicationId: "portal",
      })[spec.key];
    case "supplied":
      // The one value an operator (or `db:provision`) supplies.
      return spec.key === "DATABASE_URL"
        ? "postgresql://app:secret@db.example.com:5432/app"
        : undefined;
    default:
      return undefined;
  }
}

const required = ENV_SPECS.filter((spec) => spec.level === "required");

/** A production environment holding drk-deploy's required keys and nothing else. */
function cliRequiredEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  for (const spec of required) env[spec.key] = valueFor(spec);
  return env;
}

describe("drk-deploy's required keys are the kit's (F-45)", () => {
  it("REQUIRED_KEYS is the `required` level of the spec it exports", () => {
    expect([...REQUIRED_KEYS]).toEqual(required.map((spec) => spec.key));
  });

  it("this suite can produce a value for every required key", () => {
    for (const spec of required) {
      expect(
        valueFor(spec),
        `${spec.key} (source ${spec.source}) needs a valid production value in valueFor`,
      ).toBeTruthy();
    }
  });

  it("SUFFICIENT: drk-deploy's required keys alone boot the kit in production", () => {
    expect(
      invalidServerEnvKeys(cliRequiredEnvironment()),
      "src/lib/env.ts refuses to boot without these, but vercel-cli/src/lib/env-spec.ts does not " +
        "mark them `required`, so env:sync never writes them and env:check passes without them",
    ).toEqual([]);
  });

  it("NECESSARY: the kit refuses to boot without each one, and names it", () => {
    for (const spec of required) {
      const env = cliRequiredEnvironment();
      delete env[spec.key];
      expect(
        invalidServerEnvKeys(env),
        `${spec.key} is \`required\` in env-spec, but the kit boots without it`,
      ).toContain(spec.key);
    }
  });

  it("with nothing set, the kit names exactly drk-deploy's required keys", () => {
    // The same derivation from the other end: the keys the schema cannot
    // default or leave unset. A key with a default, or one only a cross-field
    // rule requires (EMAIL_FROM once EMAIL_PROVIDER is set), is not in it.
    expect(invalidServerEnvKeys({ NODE_ENV: "production" })).toEqual([...REQUIRED_KEYS].sort());
  });
});
