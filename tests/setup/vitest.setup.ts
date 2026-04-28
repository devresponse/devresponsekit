import "@testing-library/jest-dom/vitest";

/**
 * Global Vitest setup.
 *
 * Adds `@testing-library/jest-dom` matchers and ensures process.env has
 * test-friendly defaults so server modules that read env at import time
 * do not throw during unit tests.
 */
// `process.env.NODE_ENV` is typed as readonly in Next's typings; use a
// dynamic assignment to set the test default without conflicting with that.
if (!process.env["NODE_ENV"]) {
  Object.assign(process.env, { NODE_ENV: "test" });
}
process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.SSO_HANDOFF_ISSUER ??= "https://test.devresponse.local";
process.env.SSO_HANDOFF_AUDIENCE_PREFIX ??= "devresponse-app";
process.env.SSO_HANDOFF_JWT_SECRET ??= "test-sso-secret-test-sso-secret";
process.env.SSO_HANDOFF_TTL_SECONDS ??= "60";
