/**
 * Vitest shim for the Next.js `server-only` import guard.
 *
 * The real package throws if loaded in a Client Component bundle. In
 * unit tests, code is always loaded under Node, so the import is a
 * no-op and we export an empty module.
 */
export {};
