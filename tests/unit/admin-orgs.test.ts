import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the orgs.server.ts helpers (docs/admin-manager.md
 * §5.2, Phase 5 unit coverage). Pins SLUG_RE validation and the
 * guard functions loadOrgOrThrow/assertOrgEmpty/assertOrgNotDefault.
 */
const selectFirst = vi.fn();
const countExecute = vi.fn();

vi.mock("@/db/database", () => {
  function makeChain() {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "executeTakeFirst") return selectFirst;
          if (prop === "executeTakeFirstOrThrow") {
            return async () => {
              const v = await selectFirst();
              if (!v) throw new Error("no_row");
              return v;
            };
          }
          if (prop === "execute") return countExecute;
          return () => proxy;
        },
      },
    );
    return proxy;
  }
  return {
    db: {
      selectFrom: () => makeChain(),
    },
  };
});

beforeEach(() => {
  selectFirst.mockReset();
  countExecute.mockReset();
});
afterEach(() => vi.resetModules());

describe("SLUG_RE", () => {
  async function load() {
    return await import("@/lib/admin/orgs.server");
  }

  it("accepts lowercase single char", async () => {
    const { SLUG_RE } = await load();
    expect(SLUG_RE.test("a")).toBe(true);
    expect(SLUG_RE.test("9")).toBe(true);
  });

  it("accepts multi-char slug with hyphens", async () => {
    const { SLUG_RE } = await load();
    expect(SLUG_RE.test("acme-corp")).toBe(true);
    expect(SLUG_RE.test("acme-corp-2024")).toBe(true);
  });

  it("rejects uppercase", async () => {
    const { SLUG_RE } = await load();
    expect(SLUG_RE.test("ACME")).toBe(false);
    expect(SLUG_RE.test("Acme")).toBe(false);
  });

  it("rejects leading/trailing hyphen", async () => {
    const { SLUG_RE } = await load();
    expect(SLUG_RE.test("-foo")).toBe(false);
    expect(SLUG_RE.test("foo-")).toBe(false);
    expect(SLUG_RE.test("-foo-")).toBe(false);
  });

  it("rejects empty string", async () => {
    const { SLUG_RE } = await load();
    expect(SLUG_RE.test("")).toBe(false);
  });

  it("rejects slugs longer than 64 chars", async () => {
    const { SLUG_RE } = await load();
    const long = "a" + "b".repeat(62) + "c"; // 64 chars = ok
    const tooLong = "a" + "b".repeat(63) + "c"; // 65 chars = fail
    expect(SLUG_RE.test(long)).toBe(true);
    expect(SLUG_RE.test(tooLong)).toBe(false);
  });

  it("rejects special characters", async () => {
    const { SLUG_RE } = await load();
    expect(SLUG_RE.test("acme_corp")).toBe(false);
    expect(SLUG_RE.test("acme.corp")).toBe(false);
    expect(SLUG_RE.test("acme corp")).toBe(false);
  });
});

describe("loadOrgOrThrow", () => {
  async function load() {
    return await import("@/lib/admin/orgs.server");
  }

  it("throws organization_not_found when row missing", async () => {
    selectFirst.mockResolvedValue(undefined);
    const { loadOrgOrThrow, AdminError } = await load();
    await expect(
      loadOrgOrThrow("a1b2c3d4-e5f6-7890-abcd-ef1234567890"),
    ).rejects.toThrow(AdminError);
    await expect(
      loadOrgOrThrow("a1b2c3d4-e5f6-7890-abcd-ef1234567890"),
    ).rejects.toMatchObject({ code: "organization_not_found" });
  });

  it("returns LoadedOrg when row exists", async () => {
    const row = {
      id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      slug: "acme-corp",
      name: "ACME Corp",
      status: "active",
      is_default: false,
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    };
    selectFirst.mockResolvedValue(row);
    countExecute.mockResolvedValue([{ count: "0" }]); // for member/binding/role counts
    const { loadOrgOrThrow } = await load();
    const loaded = await loadOrgOrThrow("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(loaded.id).toBe(row.id);
    expect(loaded.slug).toBe(row.slug);
    expect(loaded.is_default).toBe(false);
  });
});

describe("assertOrgNotDefault", () => {
  async function load() {
    return await import("@/lib/admin/orgs.server");
  }

  it("throws organization_is_default when is_default is true", async () => {
    selectFirst.mockResolvedValue({ is_default: true });
    const { assertOrgNotDefault, AdminError } = await load();
    await expect(assertOrgNotDefault("org-1")).rejects.toThrow(AdminError);
    try {
      await assertOrgNotDefault("org-1");
    } catch (e) {
      expect((e as { code: string }).code).toBe("organization_is_default");
    }
  });

  it("does not throw when is_default is false", async () => {
    selectFirst.mockResolvedValue({ is_default: false });
    const { assertOrgNotDefault } = await load();
    await expect(assertOrgNotDefault("org-1")).resolves.not.toThrow();
  });

  it("does not throw when org not found (allows later 404)", async () => {
    selectFirst.mockResolvedValue(null);
    const { assertOrgNotDefault } = await load();
    await expect(assertOrgNotDefault("org-1")).resolves.not.toThrow();
  });
});

describe("assertOrgEmpty", () => {
  async function load() {
    return await import("@/lib/admin/orgs.server");
  }

  it("throws organization_not_empty when org has members", async () => {
    selectFirst.mockResolvedValue({ count: "1" });
    const { assertOrgEmpty, AdminError } = await load();
    await expect(assertOrgEmpty("org-123")).rejects.toThrow(AdminError);
    await expect(assertOrgEmpty("org-123")).rejects.toMatchObject({
      code: "organization_not_empty",
    });
  });

  it("does not throw when org is empty", async () => {
    selectFirst.mockResolvedValue({ count: "0" });
    const { assertOrgEmpty } = await load();
    await expect(assertOrgEmpty("org-123")).resolves.not.toThrow();
  });
});
