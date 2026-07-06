import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, pgPool } from "@/db/database";
import { resolveOrganizationByIdentifier } from "@/lib/org-lookup.server";

/**
 * DB-BACKED tests for `resolveOrganizationByIdentifier` — the lookup behind the
 * organization-scoped sign-in entry points (`/sign-in/<org>`, `?org=<slug>`).
 *
 * Proves what the mocked unit tests can't:
 *   - slug (case-insensitive) and UUID id both resolve an ACTIVE org;
 *   - a non-UUID identifier resolves via slug WITHOUT raising 22P02 (the id
 *     branch is shape-guarded) — the safety property;
 *   - unknown identifiers and non-active orgs resolve to null.
 *
 * Driven by `pnpm test:db`; excluded from `pnpm test`. Fixtures use a
 * `__dbtest_` prefix and self-clean.
 */
const PREFIX = "__dbtest_orglookup_";

async function cleanup(): Promise<void> {
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

async function newOrg(slug: string, status = "active"): Promise<string> {
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}${slug}`, name: `DBTest ${slug}`, status })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("resolveOrganizationByIdentifier (DB-backed)", () => {
  it("resolves an active org by slug, case-insensitively", async () => {
    const id = await newOrg("acme");
    const exact = await resolveOrganizationByIdentifier(`${PREFIX}acme`);
    expect(exact?.id).toBe(id);
    const upper = await resolveOrganizationByIdentifier(`${PREFIX}acme`.toUpperCase());
    expect(upper?.id).toBe(id);
  });

  it("resolves an active org by its UUID id", async () => {
    const id = await newOrg("byid");
    const byId = await resolveOrganizationByIdentifier(id);
    expect(byId?.id).toBe(id);
    expect(byId?.slug).toBe(`${PREFIX}byid`);
  });

  it("returns null for a non-UUID identifier that matches no slug (no 22P02 crash)", async () => {
    // The id branch must never run a uuid comparison against this garbage.
    expect(await resolveOrganizationByIdentifier("not-a-uuid !!")).toBeNull();
    expect(await resolveOrganizationByIdentifier("")).toBeNull();
  });

  it("returns null for a well-formed but unknown UUID", async () => {
    expect(
      await resolveOrganizationByIdentifier("00000000-0000-4000-8000-000000000000"),
    ).toBeNull();
  });

  it("does not resolve a non-active organization (by slug or id)", async () => {
    const id = await newOrg("gone", "suspended");
    expect(await resolveOrganizationByIdentifier(`${PREFIX}gone`)).toBeNull();
    expect(await resolveOrganizationByIdentifier(id)).toBeNull();
  });
});
