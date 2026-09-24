import { SchemaMismatchError } from "@better-auth/core/db/internal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { schemaMismatchFindings } from "@/lib/auth-schema-check.server";

/**
 * The Better Auth half of readiness (F-26), `auth-schema-check.server.ts`.
 *
 * `schemaMismatchFindings` recognises better-auth's `SchemaMismatchError` by
 * its documented `code`, because the class lives in an internal entry point;
 * the first case builds the REAL class, so a rename upstream fails here
 * rather than turning every mismatch into `database_unreachable`.
 * `betterAuthSchemaVerdict` is driven over a mocked `@/lib/auth`; the live
 * version is tests/db/readiness.db.test.ts.
 */

describe("schemaMismatchFindings", () => {
  it("reads the findings of better-auth's real SchemaMismatchError", () => {
    const error = new SchemaMismatchError(
      [
        { kind: "missing-table", table: "rateLimit" },
        { kind: "missing-column", table: "session", column: "impersonatedBy" },
      ],
      "database",
    );
    expect(schemaMismatchFindings(error)).toEqual([
      { kind: "missing-table", table: "rateLimit" },
      { kind: "missing-column", table: "session", column: "impersonatedBy" },
    ]);
  });

  it("returns null for any other error or value", () => {
    expect(schemaMismatchFindings(new Error("Connection terminated"))).toBeNull();
    expect(
      schemaMismatchFindings(Object.assign(new Error("x"), { code: "SCHEMA_MISMATCH" })),
    ).toBeNull();
    expect(schemaMismatchFindings({ code: "SCHEMA_MISMATCH", findings: [] })).toBeNull();
    expect(schemaMismatchFindings(undefined)).toBeNull();
  });
});

describe("betterAuthSchemaVerdict", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/auth");
    vi.resetModules();
  });

  /** Loads the module over an `auth` whose `$context` settles as `context` does. */
  async function withContext(context: () => Promise<unknown>) {
    vi.resetModules();
    vi.doMock("@/lib/auth", () => ({
      auth: {
        get $context() {
          return context();
        },
      },
    }));
    return (await import("@/lib/auth-schema-check.server")).betterAuthSchemaVerdict;
  }

  it("is ok when Better Auth's check is clean (returns nothing) or resolves", async () => {
    let verdict = await withContext(async () => ({ checkSchema: () => undefined }));
    await expect(verdict()).resolves.toEqual({ state: "ok" });
    verdict = await withContext(async () => ({ checkSchema: () => Promise.resolve() }));
    await expect(verdict()).resolves.toEqual({ state: "ok" });
  });

  it("is ok when the adapter registers no check (validateSchema: false), as Better Auth then gates nothing", async () => {
    const verdict = await withContext(async () => ({}));
    await expect(verdict()).resolves.toEqual({ state: "ok" });
  });

  it("is behind, with the findings, on a schema mismatch", async () => {
    const mismatch = new SchemaMismatchError(
      [{ kind: "missing-table", table: "rateLimit" }],
      "database",
    );
    const verdict = await withContext(async () => ({
      checkSchema: () => Promise.reject(mismatch),
    }));
    await expect(verdict()).resolves.toEqual({
      state: "behind",
      findings: [{ kind: "missing-table", table: "rateLimit" }],
    });
  });

  it("is unreachable when the check itself fails, keeping the error for the log", async () => {
    const failure = new Error("Connection terminated unexpectedly");
    const verdict = await withContext(async () => ({ checkSchema: () => Promise.reject(failure) }));
    await expect(verdict()).resolves.toEqual({ state: "unreachable", error: failure });
  });

  it("is misconfigured when Better Auth's context does not initialise", async () => {
    const failure = new Error("Invalid base URL");
    const verdict = await withContext(() => Promise.reject(failure));
    await expect(verdict()).resolves.toEqual({ state: "misconfigured", error: failure });
  });

  it("is misconfigured, and does not throw, when `@/lib/auth` itself fails to load", async () => {
    vi.resetModules();
    vi.doMock("@/lib/auth", () => {
      throw new Error("Invalid server environment variables: BETTER_AUTH_SECRET (too short)");
    });
    const { betterAuthSchemaVerdict: verdict } = await import("@/lib/auth-schema-check.server");
    await expect(verdict()).resolves.toMatchObject({ state: "misconfigured" });
  });
});
