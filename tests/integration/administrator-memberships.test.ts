import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as Route from "@/app/api/administrator/memberships/route";

/**
 * ADR-0001 — cross-org membership search is org-scoped. A SUPERADMIN sees
 * every org; an ORG ADMIN only their own; an admin with no resolvable org
 * gets an empty page, never "all".
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const itemsExecute = vi.fn();
const countFirst = vi.fn();

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/lib/audit.server", () => ({ auditEvent: () => {} }));
vi.mock("@/db/database", () => {
  function chain(): unknown {
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "execute") return itemsExecute;
          if (prop === "executeTakeFirst") return countFirst;
          return (...args: unknown[]) => {
            const cb = args[0];
            if (typeof cb === "function") {
              try {
                (cb as (x: unknown) => unknown)(chain());
              } catch {
                /* best-effort */
              }
            }
            return chain();
          };
        },
      },
    );
  }
  return { db: { selectFrom: () => chain() } };
});

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const access = (perms: string[], org: string | null, superuser = false) => ({
  appUserId: "admin-1",
  primaryEmail: "a@x.com",
  status: "active",
  organizationId: org,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: superuser ? [...perms, "superuser"] : perms,
});

const listReq = (): NextRequest =>
  ({
    nextUrl: new URL("http://test.local/api/administrator/memberships"),
    headers: new Headers(),
  }) as unknown as NextRequest;

let GET: typeof Route.GET;

beforeEach(async () => {
  for (const m of [sessionGetter, accessGetter, itemsExecute, countFirst]) m.mockReset();
  itemsExecute.mockResolvedValue([{ id: "m-1", organization_id: ORG_A }]);
  countFirst.mockResolvedValue({ total: "1" });
  sessionGetter.mockResolvedValue({ user: { id: "ba-actor" } });
  ({ GET } = await import("@/app/api/administrator/memberships/route"));
});
afterEach(() => vi.resetModules());

describe("GET /administrator/memberships", () => {
  it("403 without admin.orgs.read", async () => {
    accessGetter.mockResolvedValue(access(["shell.view"], ORG_A));
    expect((await GET(listReq())).status).toBe(403);
  });

  it("ORG ADMIN gets 200 (scoped to their org)", async () => {
    accessGetter.mockResolvedValue(access(["admin.orgs.read"], ORG_A));
    const res = await GET(listReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
  });

  it("SUPERADMIN gets 200 across all orgs", async () => {
    accessGetter.mockResolvedValue(access(["admin.orgs.read"], null, true));
    expect((await GET(listReq())).status).toBe(200);
  });

  it("a null-scope admin gets an EMPTY page, never 'all'", async () => {
    // organizationId null + no superuser ⇒ resolveOrgScope() === null.
    accessGetter.mockResolvedValue(access(["admin.orgs.read"], null));
    const res = await GET(listReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.items).toHaveLength(0);
    expect(body.total).toBe(0);
  });
});
