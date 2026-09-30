import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * `DELETE /api/administrator/api-keys/[id]` audits only a revoke that happened
 * (F-72).
 *
 * The route reads the key, answers `alreadyRevoked` when it is not active, and
 * otherwise calls `revokeApiKey`, whose UPDATE re-asserts `status = 'active'`.
 * A concurrent revoke or rotation that commits between the read and that
 * UPDATE leaves it matching nothing (proven against Postgres in
 * tests/db/credential-rotation-race.db.test.ts). The route used to ignore that
 * result: it answered `{ ok: true }` and wrote an `admin.api_key.revoked` row
 * naming this admin for a key someone else had already retired. The guard,
 * the key lookup, `revokeApiKey`, audit and the rate limiter are stubbed here.
 *
 * Each answer is also checked against the committed admin spec (F-74):
 * `AdminApiKeyRevoked` requires `alreadyRevoked`, which the revoke that
 * happened left out, so the generated SDK's `instanceOfAdminApiKeyRevoked`
 * rejected it and `alreadyRevoked === false` never held.
 */
const requireAdminPermission = vi.fn();
const revokeApiKey = vi.fn();
const auditEvent = vi.fn();
const keyLookup = vi.fn();

vi.mock("@/lib/admin/permissions.server", () => ({
  requireAdminPermission: (...a: unknown[]) => requireAdminPermission(...a),
  isAdminPermissionDenial: (g: { __denied?: boolean }) => g?.__denied === true,
}));
vi.mock("@/db/database", () => {
  const chain: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "executeTakeFirst") return () => keyLookup();
        return () => chain;
      },
    },
  );
  return { db: { selectFrom: () => chain } };
});
vi.mock("@/lib/api-auth/api-keys.server", () => ({
  revokeApiKey: (...a: unknown[]) => revokeApiKey(...a),
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditEvent(...a) }));
vi.mock("@/lib/http/rate-limit.server", () => ({
  enforceRateLimit: () => null,
  DEFAULT_ADMIN_MUTATION_LIMIT: {},
}));
vi.mock("@/lib/admin/access-scope.server", () => ({ canAccessOrg: () => true }));

import { DELETE } from "@/app/api/administrator/api-keys/[id]/route";
import { expectResponseMatchesSpec } from "../helpers/openapi-response";

const KEY_ID = "11111111-1111-4111-8111-111111111111";
const ctx = () => ({ params: Promise.resolve({ id: KEY_ID }) });
const revoked = (res: Response) =>
  expectResponseMatchesSpec(res, "admin", "delete", "/api-keys/{id}");
const del = () =>
  new NextRequest(`https://app.test/api/administrator/api-keys/${KEY_ID}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "leaked" }),
  });

beforeEach(() => {
  requireAdminPermission.mockReset().mockResolvedValue({
    access: { permissions: ["admin.apikeys.manage"], appUserId: "actor-1" },
    betterAuthUserId: "admin-1",
    requestId: "req-1",
  });
  keyLookup.mockReset().mockResolvedValue({
    id: KEY_ID,
    app_user_id: "owner-1",
    status: "active",
    key_prefix: "drk_test_AbCd1234",
    organization_id: "org-1",
  });
  revokeApiKey.mockReset().mockResolvedValue(true);
  auditEvent.mockReset();
});

describe("DELETE /api/administrator/api-keys/[id] — act on the revoke's result (F-72)", () => {
  it("revokes an active key and audits it once", async () => {
    const res = await DELETE(del(), ctx());
    expect(res.status).toBe(200);
    expect(await revoked(res)).toEqual({ ok: true, alreadyRevoked: false });
    expect(revokeApiKey).toHaveBeenCalledWith(KEY_ID, "actor-1", "leaked");
    expect(auditEvent).toHaveBeenCalledTimes(1);
    expect(auditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "admin.api_key.revoked", reason: "leaked" }),
    );
  });

  it("a revoke that lost a race answers alreadyRevoked and writes no audit row", async () => {
    // Active at the read; a rotation (or another admin) retired it first.
    revokeApiKey.mockResolvedValue(false);
    const res = await DELETE(del(), ctx());
    expect(res.status).toBe(200);
    expect(await revoked(res)).toEqual({ ok: true, alreadyRevoked: true });
    expect(revokeApiKey).toHaveBeenCalledTimes(1);
    expect(auditEvent).not.toHaveBeenCalled();
  });

  it("CONTROL: a key already revoked at the read is not revoked again", async () => {
    keyLookup.mockResolvedValue({
      id: KEY_ID,
      app_user_id: "owner-1",
      status: "revoked",
      key_prefix: "drk_test_AbCd1234",
      organization_id: "org-1",
    });
    const res = await DELETE(del(), ctx());
    expect(await revoked(res)).toEqual({ ok: true, alreadyRevoked: true });
    expect(revokeApiKey).not.toHaveBeenCalled();
    expect(auditEvent).not.toHaveBeenCalled();
  });
});
