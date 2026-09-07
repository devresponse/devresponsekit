import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as JwtHandoffModule from "@/lib/jwt-handoff.server";
import type * as SsoServerModule from "@/lib/sso.server";

/**
 * Unit tests for `sso.server.ts > createSsoHandoffRedirect` and
 * `consumeSsoHandoffNonce`. The DB layer and JWT signer are mocked so
 * we can assert: missing context → throws `sso_denied:*`, application
 * not in user's org → throws, success → returns a URL with the token
 * appended to `/api/sso/consume` on the target origin, and nonce
 * consumption is atomic (one update per call).
 */

const accessGetter = vi.fn();
const signMock = vi.fn();

const enterpriseTakeFirst = vi.fn();
const nonceInsertExecute = vi.fn().mockResolvedValue(undefined);
const nonceInsertValues = vi.fn();
const nonceDeleteExecute = vi.fn().mockResolvedValue(undefined);
const nonceUpdateExecute = vi.fn();
const nonceUpdateWhere = vi.fn();

vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return {
    ...actual,
    getUserAccessContext: (id: string) => accessGetter(id),
  };
});
vi.mock("@/lib/jwt-handoff.server", async () => {
  const actual = await vi.importActual<typeof JwtHandoffModule>("@/lib/jwt-handoff.server");
  return {
    ...actual,
    signSsoHandoff: (...args: unknown[]) => signMock(...args),
  };
});

vi.mock("@/db/database", () => ({
  db: {
    selectFrom: (table: string) => {
      if (table === "app_enterprise_applications") {
        // Single call site: createSsoHandoffRedirect looks the target
        // app up once and passes it to loadSsoAccessContext.
        return {
          selectAll: () => ({
            where: () => ({
              where: () => ({
                executeTakeFirst: enterpriseTakeFirst,
              }),
            }),
          }),
        };
      }
      // Review #60: the handoff no longer queries roles — any other table
      // read from here is a regression.
      throw new Error(`unexpected selectFrom(${table})`);
    },
    insertInto: () => ({
      values: (row: unknown) => {
        nonceInsertValues(row);
        return { execute: nonceInsertExecute };
      },
    }),
    deleteFrom: () => ({ where: () => ({ execute: nonceDeleteExecute }) }),
    updateTable: () => ({
      set: () => {
        // Record every `where(lhs, op, rhs)` so the test can pin the burn
        // predicate (jti + target_application_id + consumed_at + expires_at).
        const chain = {
          where: (...args: unknown[]) => {
            nonceUpdateWhere(...args);
            return chain;
          },
          returning: () => ({ executeTakeFirst: nonceUpdateExecute }),
        };
        return chain;
      },
    }),
  },
}));

let mod: typeof SsoServerModule;

const ACTIVE_ACCESS_FULL = {
  appUserId: "u-1",
  primaryEmail: "u@x.com",
  status: "active" as const,
  organizationId: "o-1",
  membershipStatus: "active" as const,
  preferredLocale: "en",
  permissions: ["shell.view"],
};

beforeEach(async () => {
  accessGetter.mockReset();
  signMock.mockReset();
  enterpriseTakeFirst.mockReset();
  nonceInsertExecute.mockClear();
  nonceInsertValues.mockClear();
  nonceDeleteExecute.mockClear();
  nonceUpdateExecute.mockReset();
  nonceUpdateWhere.mockReset();
  mod = await import("@/lib/sso.server");
});
afterEach(() => vi.resetModules());

describe("createSsoHandoffRedirect", () => {
  it("throws sso_denied:pending_approval when user is not allowed", async () => {
    enterpriseTakeFirst.mockResolvedValue({
      id: "portal",
      origin: "https://portal.x.com",
      sso_audience: "devresponse-app:portal",
      organization_id: null,
      status: "available",
    });
    accessGetter.mockResolvedValue({
      ...ACTIVE_ACCESS_FULL,
      status: "pending_approval",
      membershipStatus: "pending_approval",
    });
    await expect(
      mod.createSsoHandoffRedirect({
        applicationId: "portal",
        betterAuthUserId: "ba-1",
      }),
    ).rejects.toThrow(/sso_denied:pending_approval/);
  });

  it("throws sso_denied:application_unavailable when target app is not found", async () => {
    accessGetter.mockResolvedValue(ACTIVE_ACCESS_FULL);
    enterpriseTakeFirst.mockResolvedValue(undefined);
    await expect(
      mod.createSsoHandoffRedirect({
        applicationId: "portal",
        betterAuthUserId: "ba-1",
      }),
    ).rejects.toThrow(/application_unavailable/);
  });

  it("throws when the application belongs to a different organization", async () => {
    accessGetter.mockResolvedValue(ACTIVE_ACCESS_FULL);
    enterpriseTakeFirst.mockResolvedValue({
      id: "portal",
      origin: "https://portal.x.com",
      sso_audience: "devresponse-app:portal",
      organization_id: "different-org",
      status: "available",
    });
    await expect(
      mod.createSsoHandoffRedirect({
        applicationId: "portal",
        betterAuthUserId: "ba-1",
      }),
    ).rejects.toThrow(/application_not_in_organization/);
  });

  it("returns the consume URL with the signed token on success", async () => {
    accessGetter.mockResolvedValue(ACTIVE_ACCESS_FULL);
    enterpriseTakeFirst.mockResolvedValue({
      id: "portal",
      origin: "https://portal.x.com",
      sso_audience: "devresponse-app:portal",
      organization_id: null,
      status: "available",
    });
    signMock.mockResolvedValue("signed-token");

    const url = await mod.createSsoHandoffRedirect({
      applicationId: "portal",
      betterAuthUserId: "ba-1",
    });

    expect(url.toString()).toBe("https://portal.x.com/api/sso/consume?token=signed-token");
    expect(nonceInsertExecute).toHaveBeenCalledTimes(1);
    expect(signMock).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: "devresponse-app:portal",
        ttlSeconds: expect.any(Number),
        claims: expect.objectContaining({ targetApplicationId: "portal" }),
      }),
    );
    // Review #60: the URL-borne token carries ONLY what a consumer needs.
    const [signInput] = signMock.mock.calls[0] as [{ claims: Record<string, unknown> }];
    expect(signInput.claims).toEqual({
      email: "u@x.com",
      targetApplicationId: "portal",
      locale: "en",
    });
    expect(signInput.claims).not.toHaveProperty("roles");
    expect(signInput.claims).not.toHaveProperty("organizationId");
    expect(signInput.claims).not.toHaveProperty("appUserId");
  });
});

/**
 * Review #209: the handoff TTL is read from the VALIDATED env schema, not
 * raw `process.env`. The old `Number(process.env.SSO_HANDOFF_TTL_SECONDS ?? 60)`
 * accepted anything: a typo'd value became `NaN`, `clampSsoHandoffTtl(NaN)`
 * returned `NaN` (Math.min/Math.max propagate it), and the nonce row was
 * written with `expires_at: Invalid Date` — a handoff that can never be
 * consumed, discovered only in production. The schema rejects the same value
 * at the boundary instead.
 */
describe("createSsoHandoffRedirect — TTL source (review #209)", () => {
  const original = process.env.SSO_HANDOFF_TTL_SECONDS;
  afterEach(() => {
    if (original === undefined) delete process.env.SSO_HANDOFF_TTL_SECONDS;
    else process.env.SSO_HANDOFF_TTL_SECONDS = original;
  });

  async function launch() {
    accessGetter.mockResolvedValue(ACTIVE_ACCESS_FULL);
    enterpriseTakeFirst.mockResolvedValue({
      id: "portal",
      origin: "https://portal.x.com",
      sso_audience: "devresponse-app:portal",
      organization_id: null,
      status: "available",
    });
    signMock.mockResolvedValue("signed-token");
    vi.resetModules();
    const fresh = await import("@/lib/sso.server");
    return fresh.createSsoHandoffRedirect({ applicationId: "portal", betterAuthUserId: "ba-1" });
  }

  it("uses the configured TTL for the nonce row and the signed token", async () => {
    process.env.SSO_HANDOFF_TTL_SECONDS = "30";
    const before = Date.now();
    await launch();
    const [row] = nonceInsertValues.mock.calls[0] as [{ expires_at: Date }];
    expect(Number.isNaN(row.expires_at.getTime())).toBe(false);
    const ttlMs = row.expires_at.getTime() - before;
    // `before` is sampled ahead of the module re-import, so allow slack for
    // it; the point is that the row expires ~30s out (the configured TTL) and
    // not at the 60s default, nor at an Invalid Date.
    expect(ttlMs).toBeGreaterThan(25_000);
    expect(ttlMs).toBeLessThan(40_000);
    expect(signMock).toHaveBeenCalledWith(expect.objectContaining({ ttlSeconds: 30 }));
  });

  it("refuses a non-numeric TTL at the env boundary instead of writing an Invalid Date", async () => {
    process.env.SSO_HANDOFF_TTL_SECONDS = "not-a-number";
    await expect(launch()).rejects.toThrow(/Invalid server environment variables/);
    expect(nonceInsertValues).not.toHaveBeenCalled();
  });
});

describe("consumeSsoHandoffNonce", () => {
  it("returns true exactly once per token (atomic update)", async () => {
    nonceUpdateExecute.mockResolvedValueOnce({ jti: "j1" });
    expect(await mod.consumeSsoHandoffNonce("j1", "portal")).toBe(true);

    nonceUpdateExecute.mockResolvedValueOnce(undefined);
    expect(await mod.consumeSsoHandoffNonce("j1", "portal")).toBe(false);
  });

  it("predicates the burn on target_application_id as well as jti (review #15)", async () => {
    nonceUpdateExecute.mockResolvedValueOnce(undefined);
    await mod.consumeSsoHandoffNonce("j1", "portal");
    expect(nonceUpdateWhere).toHaveBeenCalledWith("jti", "=", "j1");
    expect(nonceUpdateWhere).toHaveBeenCalledWith("target_application_id", "=", "portal");
    expect(nonceUpdateWhere).toHaveBeenCalledWith("consumed_at", "is", null);
    expect(nonceUpdateWhere).toHaveBeenCalledWith("expires_at", ">", expect.any(Date));
  });
});
