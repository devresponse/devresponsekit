import "@testing-library/jest-dom/vitest";

/**
 * Global Vitest setup.
 *
 * Adds `@testing-library/jest-dom` matchers and ensures process.env has
 * test-friendly defaults so server modules that read env at import time
 * do not throw during unit tests.
 *
 * Also installs jsdom polyfills required by Radix UI primitives. jsdom
 * does not implement Pointer Events, `Element.scrollIntoView`,
 * `Element.hasPointerCapture`, or `ResizeObserver`, all of which Radix's
 * Select / Dialog / Popover and the cmdk Command primitives call as part
 * of their interaction handlers. Without the polyfills, opening one of
 * these inside a jsdom test throws a TypeError / ReferenceError that
 * escapes the test runner.
 */
// `process.env.NODE_ENV` is typed as readonly in Next's typings; use a
// dynamic assignment to set the test default without conflicting with that.
if (!process.env["NODE_ENV"]) {
  Object.assign(process.env, { NODE_ENV: "test" });
}
process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5444/test";
// The issuer equals BETTER_AUTH_URL so the suite runs as a SELF-ISSUER: the
// handoff verifier uses the local public key set (no JWKS fetch), exactly like
// a single-deployment rig. The signing key is an ephemeral per-worker Ed25519
// JWK (review #5) — never a committed value.
process.env.SSO_HANDOFF_ISSUER ??= "http://localhost:3000";
process.env.SSO_HANDOFF_AUDIENCE_PREFIX ??= "devresponse-app";
process.env.SSO_HANDOFF_APPLICATION_ID ??= "portal";
process.env.SSO_HANDOFF_TTL_SECONDS ??= "60";
if (!process.env.SSO_HANDOFF_PRIVATE_KEY) {
  const { exportJWK, generateKeyPair } = await import("jose");
  const { privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  process.env.SSO_HANDOFF_PRIVATE_KEY = JSON.stringify(await exportJWK(privateKey));
}
// P2-5: enterprise-app origin allow-list. The integration tests register
// apps under example.com / devresponse.* origins.
process.env.SSO_ALLOWED_ORIGIN_SUFFIXES ??= "example.com,devresponse.com,devresponse.local";

// jsdom does not implement `window.matchMedia`, which `useIsMobile`
// (and therefore the sidebar components) call during render. Stub a
// non-matching MediaQueryList so components take the desktop branch.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

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

// jsdom does not implement `ResizeObserver`, which cmdk (the Command /
// combobox primitive) constructs on mount. Provide a no-op so combobox
// components render under jsdom.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}
