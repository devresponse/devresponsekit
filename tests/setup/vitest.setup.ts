import "@testing-library/jest-dom/vitest";

/**
 * Global Vitest setup.
 *
 * Adds `@testing-library/jest-dom` matchers and ensures process.env has
 * test-friendly defaults so server modules that read env at import time
 * do not throw during unit tests.
 *
 * Also installs jsdom polyfills required by Radix UI primitives. jsdom
 * does not implement Pointer Events, `Element.scrollIntoView`, or
 * `Element.hasPointerCapture`, all of which Radix's Select / Dialog
 * primitives call as part of their interaction handlers. Without the
 * polyfills, opening a Radix Select inside a jsdom test throws a
 * TypeError that escapes the test runner.
 */
// `process.env.NODE_ENV` is typed as readonly in Next's typings; use a
// dynamic assignment to set the test default without conflicting with that.
if (!process.env["NODE_ENV"]) {
  Object.assign(process.env, { NODE_ENV: "test" });
}
process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5444/test";
process.env.SSO_HANDOFF_ISSUER ??= "https://test.devresponse.local";
process.env.SSO_HANDOFF_AUDIENCE_PREFIX ??= "devresponse-app";
process.env.SSO_HANDOFF_JWT_SECRET ??= "test-sso-secret-test-sso-secret";
process.env.SSO_HANDOFF_TTL_SECONDS ??= "60";

if (typeof globalThis.Element !== "undefined") {
  const ElementProto = globalThis.Element.prototype as Element & {
    hasPointerCapture?: (pointerId: number) => boolean;
    releasePointerCapture?: (pointerId: number) => void;
    setPointerCapture?: (pointerId: number) => void;
    scrollIntoView?: () => void;
  };
  if (!ElementProto.hasPointerCapture) {
    ElementProto.hasPointerCapture = () => false;
  }
  if (!ElementProto.releasePointerCapture) {
    ElementProto.releasePointerCapture = () => {};
  }
  if (!ElementProto.setPointerCapture) {
    ElementProto.setPointerCapture = () => {};
  }
  if (!ElementProto.scrollIntoView) {
    ElementProto.scrollIntoView = () => {};
  }
}
