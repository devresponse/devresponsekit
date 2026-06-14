import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as OutboxRouteModule from "@/app/api/administrator/email/outbox/route";
import type * as TemplatesRouteModule from "@/app/api/administrator/email/templates/route";
import type * as TemplateRouteModule from "@/app/api/administrator/email/templates/[id]/route";
import type * as TestRouteModule from "@/app/api/administrator/email/test/route";

/**
 * Integration tests for the administrator email endpoints (specs.md
 * §35). The DB and sender layers are stubbed — these tests pin the
 * handler contracts: permission gates (`admin.email.read` vs
 * `admin.email.manage`), the list envelope, template-update validation,
 * and the test-send pipeline call.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const itemsExecute = vi.fn();
const selectFirst = vi.fn();
const updateFirst = vi.fn();
const sendMock = vi.fn();

vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
}));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return {
    ...actual,
    getUserAccessContext: (id: string) => accessGetter(id),
  };
});
vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...args: unknown[]) => auditMock(...args),
}));
vi.mock("@/lib/email/send.server", () => ({
  sendAppEmail: (...args: unknown[]) => sendMock(...args),
}));

vi.mock("@/db/database", () => {
  function makeChain() {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "execute") return itemsExecute;
          if (prop === "executeTakeFirst") return selectFirst;
          return (...args: unknown[]) => {
            const cb = args[0];
            if (typeof cb === "function") {
              try {
                (cb as (eb: unknown) => unknown)(
                  new Proxy(() => ({}), {
                    get: () => () => ({}),
                    apply: () => ({}),
                  }),
                );
              } catch {
                /* ignore — eb stub is best-effort */
              }
            }
            return proxy;
          };
        },
      },
    );
    return proxy;
  }
  return {
    db: {
      selectFrom: () => makeChain(),
      updateTable: () => ({
        set: () => ({
          where: () => ({
            returning: () => ({ executeTakeFirst: updateFirst }),
          }),
        }),
      }),
    },
  };
});

const TEMPLATE_ID = "11111111-2222-4333-8444-555555555555";

function makeReq(path: string, init?: { method?: string; body?: unknown }): NextRequest {
  const url = new URL(`http://test.local${path}`);
  return {
    nextUrl: url,
    url: url.toString(),
    method: init?.method ?? "GET",
    headers: new Headers({ origin: "http://test.local" }),
    json: async () => init?.body,
  } as unknown as NextRequest;
}

// This is a CONTRACT suite (permission gates, envelopes, validation), not
// the org-scoping suite — outbox tenant isolation lives in
// `org-scoped-admin-routes.test.ts` and `email-send.test.ts`. The actor
// holds `superuser` so a single access shape reaches every success path,
// including the SUPERADMIN-only template WRITE (PUT). "Lacks permission" 403
// tests stay valid — `superuser` is never the specific gated permission.
const OK_ACCESS = (perms: string[]) => ({
  appUserId: "u-1",
  primaryEmail: "admin@x.com",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: [...perms, "superuser"],
});

let outboxGET: typeof OutboxRouteModule.GET;
let templatesGET: typeof TemplatesRouteModule.GET;
let templatePUT: typeof TemplateRouteModule.PUT;
let testPOST: typeof TestRouteModule.POST;

beforeEach(async () => {
  for (const m of [
    sessionGetter,
    accessGetter,
    auditMock,
    itemsExecute,
    selectFirst,
    updateFirst,
    sendMock,
  ])
    m.mockReset();
  itemsExecute.mockResolvedValue([]);
  selectFirst.mockResolvedValue({ total: "0" });
  sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
  ({ GET: outboxGET } = await import("@/app/api/administrator/email/outbox/route"));
  ({ GET: templatesGET } = await import("@/app/api/administrator/email/templates/route"));
  ({ PUT: templatePUT } = await import("@/app/api/administrator/email/templates/[id]/route"));
  ({ POST: testPOST } = await import("@/app/api/administrator/email/test/route"));
});
afterEach(() => vi.resetModules());

describe("GET /api/administrator/email/outbox", () => {
  it("returns 403 without admin.email.read", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.users.read"]));
    const res = await outboxGET(makeReq("/api/administrator/email/outbox"));
    expect(res.status).toBe(403);
  });

  it("returns the list envelope with default created_at desc sort", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.email.read"]));
    itemsExecute.mockResolvedValue([
      {
        id: "o-1",
        template_key: "password_reset",
        to_email: "u@x.com",
        from_email: "no-reply@x.com",
        subject: "Reset",
        body_html: "<p>x</p>",
        body_text: "x",
        status: "logged",
        provider: null,
        provider_message_id: null,
        error: null,
        related_better_auth_user_id: null,
        created_at: "2026-01-01T00:00:00Z",
        sent_at: null,
      },
    ]);
    selectFirst.mockResolvedValue({ total: "1" });
    const res = await outboxGET(makeReq("/api/administrator/email/outbox"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number; sort: unknown };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.sort).toEqual([{ field: "created_at", direction: "desc" }]);
  });

  it("accepts status/template filters and q without erroring", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.email.read"]));
    const res = await outboxGET(
      makeReq("/api/administrator/email/outbox?filter[status]=failed&filter[template_key]=x&q=u@"),
    );
    expect(res.status).toBe(200);
  });
});

describe("GET /api/administrator/email/templates", () => {
  it("returns 403 without admin.email.read", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS([]));
    const res = await templatesGET(makeReq("/api/administrator/email/templates"));
    expect(res.status).toBe(403);
  });

  it("returns the full template list", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.email.read"]));
    itemsExecute.mockResolvedValue([{ id: TEMPLATE_ID, key: "password_reset", locale: "en" }]);
    const res = await templatesGET(makeReq("/api/administrator/email/templates"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
  });
});

describe("PUT /api/administrator/email/templates/[id]", () => {
  const ctx = { params: Promise.resolve({ id: TEMPLATE_ID }) };
  const validBody = { subject: "S", body_html: "<p>b</p>", body_text: null, description: null };

  it("requires admin.email.manage — read alone is rejected", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.email.read"]));
    const res = await templatePUT(
      makeReq(`/api/administrator/email/templates/${TEMPLATE_ID}`, {
        method: "PUT",
        body: validBody,
      }),
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it("rejects unknown fields (key/locale are immutable)", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.email.manage"]));
    const res = await templatePUT(
      makeReq(`/api/administrator/email/templates/${TEMPLATE_ID}`, {
        method: "PUT",
        body: { ...validBody, key: "renamed" },
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("updates the template and audits", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.email.manage"]));
    updateFirst.mockResolvedValue({ id: TEMPLATE_ID, key: "password_reset", locale: "en" });
    const res = await templatePUT(
      makeReq(`/api/administrator/email/templates/${TEMPLATE_ID}`, {
        method: "PUT",
        body: validBody,
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "admin.email.template_updated", outcome: "success" }),
    );
  });

  it("404s on a missing template", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.email.manage"]));
    updateFirst.mockResolvedValue(undefined);
    const res = await templatePUT(
      makeReq(`/api/administrator/email/templates/${TEMPLATE_ID}`, {
        method: "PUT",
        body: validBody,
      }),
      ctx,
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/administrator/email/test", () => {
  it("requires admin.email.manage", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.email.read"]));
    const res = await testPOST(
      makeReq("/api/administrator/email/test", { method: "POST", body: { to: "t@x.com" } }),
    );
    expect(res.status).toBe(403);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid recipient", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.email.manage"]));
    const res = await testPOST(
      makeReq("/api/administrator/email/test", { method: "POST", body: { to: "not-an-email" } }),
    );
    expect(res.status).toBe(400);
  });

  it("sends through the outbox pipeline and reports the status", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.email.manage"]));
    sendMock.mockResolvedValue({ outboxId: "o-7", status: "logged" });
    const res = await testPOST(
      makeReq("/api/administrator/email/test", { method: "POST", body: { to: "t@x.com" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; outboxId: string; status: string };
    expect(body).toMatchObject({ ok: true, outboxId: "o-7", status: "logged" });
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "t@x.com", templateKey: "test_email" }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "admin.email.test_sent", outcome: "success" }),
    );
  });

  it("audits delivery failure as error but still returns the outbox row", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.email.manage"]));
    sendMock.mockResolvedValue({ outboxId: "o-8", status: "failed" });
    const res = await testPOST(
      makeReq("/api/administrator/email/test", { method: "POST", body: { to: "t@x.com" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body).toMatchObject({ ok: false, status: "failed" });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "admin.email.test_sent", outcome: "error" }),
    );
  });
});
