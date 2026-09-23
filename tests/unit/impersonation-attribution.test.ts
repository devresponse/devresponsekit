import { describe, expect, it } from "vitest";
import {
  attributeAuditActor,
  humanActorFor,
  humanActorId,
  noteSessionImpersonation,
  readRequestImpersonation,
} from "@/lib/impersonation-attribution.server";

/**
 * F-07 — the per-request impersonation record `auditEvent` and the rate
 * limiter read (`src/lib/impersonation-attribution.server.ts`).
 *
 * The record is keyed on the request's `Headers` OBJECT, the carrier every
 * guard and audit call of one request shares. These pin what gets recorded,
 * that it stays with its own request, and the attribution rule itself: a row
 * naming the borrowed identity (or already the human) is attributed to the
 * human with the borrowed identity in metadata; anything else is untouched.
 */

const IMPERSONATED = { user: { id: "ba-borrowed" }, session: { impersonatedBy: "ba-human" } };

function impersonatedRequest(): { headers: Headers } {
  const request = { headers: new Headers() };
  noteSessionImpersonation(request, IMPERSONATED);
  return request;
}

describe("noteSessionImpersonation / readRequestImpersonation", () => {
  it("records both identities of an impersonated session against the request's headers", () => {
    const request = impersonatedRequest();
    const expected = {
      impersonatedBetterAuthUserId: "ba-borrowed",
      impersonatorBetterAuthUserId: "ba-human",
    };
    expect(readRequestImpersonation(request)).toEqual(expected);
    // Keyed on the Headers object, so any carrier wrapping the same headers
    // (a NextRequest, a `{ headers }` literal, the Headers itself) sees it.
    expect(readRequestImpersonation(request.headers)).toEqual(expected);
    expect(readRequestImpersonation({ headers: request.headers })).toEqual(expected);
  });

  it("accepts the snake_case marker (plugin version drift), like readImpersonatorId", () => {
    const request = { headers: new Headers() };
    noteSessionImpersonation(request, {
      user: { id: "ba-borrowed" },
      session: { impersonated_by: "ba-human" },
    });
    expect(readRequestImpersonation(request)?.impersonatorBetterAuthUserId).toBe("ba-human");
  });

  it("records nothing for an ordinary session, no session, or a session without a user id", () => {
    for (const session of [
      { user: { id: "ba-self" }, session: { impersonatedBy: null } },
      { user: { id: "ba-self" } },
      null,
      undefined,
      { session: { impersonatedBy: "ba-human" } },
      { user: { id: "" }, session: { impersonatedBy: "ba-human" } },
    ]) {
      const request = { headers: new Headers() };
      noteSessionImpersonation(request, session);
      expect(readRequestImpersonation(request)).toBeNull();
    }
  });

  it("never leaks into another request", () => {
    impersonatedRequest();
    expect(readRequestImpersonation({ headers: new Headers() })).toBeNull();
  });

  it("tolerates a missing carrier", () => {
    expect(() => noteSessionImpersonation(undefined, IMPERSONATED)).not.toThrow();
    expect(readRequestImpersonation(undefined)).toBeNull();
    expect(readRequestImpersonation(null)).toBeNull();
  });
});

describe("humanActorFor", () => {
  it("charges the human when the key names the borrowed identity", () => {
    expect(humanActorFor("ba-borrowed", impersonatedRequest())).toBe("ba-human");
  });

  it("leaves every other key alone", () => {
    const request = impersonatedRequest();
    expect(humanActorFor("ip:203.0.113.9", request)).toBe("ip:203.0.113.9");
    expect(humanActorFor("ba-human", request)).toBe("ba-human");
    expect(humanActorFor("ba-borrowed", { headers: new Headers() })).toBe("ba-borrowed");
    expect(humanActorFor("ba-borrowed")).toBe("ba-borrowed");
  });
});

describe("humanActorId", () => {
  it("prefers the impersonator and falls back to the principal", () => {
    expect(humanActorId({ betterAuthUserId: "ba-borrowed", impersonatorId: "ba-human" })).toBe(
      "ba-human",
    );
    expect(humanActorId({ betterAuthUserId: "ba-self", impersonatorId: null })).toBe("ba-self");
    expect(humanActorId({ betterAuthUserId: "ba-self" })).toBe("ba-self");
  });
});

describe("attributeAuditActor", () => {
  it("attributes a row naming the borrowed identity to the human, keeping the caller's metadata", () => {
    expect(
      attributeAuditActor({
        actorBetterAuthUserId: "ba-borrowed",
        metadata: { fields: ["name"] },
        request: impersonatedRequest(),
      }),
    ).toEqual({
      actorBetterAuthUserId: "ba-human",
      metadata: { fields: ["name"], impersonatedBetterAuthUserId: "ba-borrowed" },
    });
  });

  it("completes a row that already names the human (the IMP-1/IMP-3 refusal shape)", () => {
    expect(
      attributeAuditActor({ actorBetterAuthUserId: "ba-human", request: impersonatedRequest() }),
    ).toEqual({
      actorBetterAuthUserId: "ba-human",
      metadata: { impersonatedBetterAuthUserId: "ba-borrowed" },
    });
  });

  it("lets the session's answer win over a caller-supplied impersonatedBetterAuthUserId", () => {
    expect(
      attributeAuditActor({
        actorBetterAuthUserId: "ba-borrowed",
        metadata: { impersonatedBetterAuthUserId: "spoofed" },
        request: impersonatedRequest(),
      }).metadata,
    ).toEqual({ impersonatedBetterAuthUserId: "ba-borrowed" });
  });

  it("leaves a row naming another principal, or no one, exactly as written", () => {
    const request = impersonatedRequest();
    const metadata = { action: "x" };
    expect(attributeAuditActor({ actorBetterAuthUserId: "ba-system", metadata, request })).toEqual({
      actorBetterAuthUserId: "ba-system",
      metadata,
    });
    expect(attributeAuditActor({ metadata, request })).toEqual({
      actorBetterAuthUserId: null,
      metadata,
    });
  });

  it("changes nothing on an ordinary request or without a request", () => {
    const metadata = { a: 1 };
    expect(
      attributeAuditActor({
        actorBetterAuthUserId: "ba-borrowed",
        metadata,
        request: { headers: new Headers() },
      }),
    ).toEqual({ actorBetterAuthUserId: "ba-borrowed", metadata });
    expect(attributeAuditActor({ actorBetterAuthUserId: "ba-borrowed", metadata })).toEqual({
      actorBetterAuthUserId: "ba-borrowed",
      metadata,
    });
  });
});
