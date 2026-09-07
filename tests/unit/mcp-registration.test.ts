import { describe, expect, it } from "vitest";
import {
  buildRegistrationResponse,
  isRegistrationOrgPermitted,
  parseRegistrationOrgAllowList,
  registrationRequestSchema,
  statusForMode,
} from "@/lib/mcp/registration";

/** Pure coverage for the RFC 7591 registration schema + response builder. */
describe("MCP registration (pure)", () => {
  it("maps the policy mode to the initial account status", () => {
    expect(statusForMode("approval")).toBe("pending_approval");
    expect(statusForMode("open")).toBe("active");
  });

  it("requires a client_name and tolerates extra RFC 7591 fields", () => {
    expect(registrationRequestSchema.safeParse({}).success).toBe(false);
    expect(registrationRequestSchema.safeParse({ client_name: "" }).success).toBe(false);
    const ok = registrationRequestSchema.safeParse({
      client_name: "My Agent",
      organization: "acme",
      grant_types: ["client_credentials"],
      redirect_uris: [],
      something_extra: true,
    });
    expect(ok.success).toBe(true);
  });

  it("builds a scopeless client-credentials registration response", () => {
    const r = buildRegistrationResponse({
      clientId: "drkc_x",
      clientSecret: "drkcsec_y",
      clientName: "My Agent",
      issuedAt: 1_700_000_000,
    });
    expect(r.client_id).toBe("drkc_x");
    expect(r.client_secret).toBe("drkcsec_y");
    expect(r.scope).toBe(""); // ZERO scopes until an admin grants
    expect(r.grant_types).toEqual(["client_credentials"]);
    expect(r.token_endpoint_auth_method).toBe("client_secret_post");
    expect(r.client_secret_expires_at).toBe(0);
  });

  /**
   * RFC 7592 registration management is deliberately NOT offered (review
   * #206). RFC 7591 §3.2.1 makes both management members optional and RFC
   * 7592 §1 keys the whole API on their presence, so OMITTING them is how a
   * server says "no management endpoint" in the protocol's own terms. This
   * pins the decision: adding either member would advertise an API that does
   * not exist (and, for the access token, a long-lived unhashed bearer handed
   * to an unauthenticated registrant). Lifecycle stays admin-side — approve /
   * scope / revoke in the Agents console, rotate via the v1 admin route.
   */
  it("advertises NO RFC 7592 management API (deliberate — review #206)", () => {
    const r = buildRegistrationResponse({
      clientId: "drkc_x",
      clientSecret: "drkcsec_y",
      clientName: "My Agent",
      issuedAt: 1_700_000_000,
    });
    expect(r).not.toHaveProperty("registration_access_token");
    expect(r).not.toHaveProperty("registration_client_uri");
    expect(Object.keys(r).sort()).toEqual([
      "client_id",
      "client_id_issued_at",
      "client_name",
      "client_secret",
      "client_secret_expires_at",
      "grant_types",
      "scope",
      "token_endpoint_auth_method",
    ]);
  });
});

/**
 * Org policy for a caller-supplied `organization` (review #51). Before the
 * fix a request body could steer a registration into ANY active org even
 * when the operator had configured MCP_REGISTRATION_DEFAULT_ORG.
 */
describe("isRegistrationOrgPermitted (review #51)", () => {
  const acme = { id: "11111111-1111-4111-8111-111111111111", slug: "acme" };
  const other = { id: "22222222-2222-4222-8222-222222222222", slug: "other" };

  it("permits any org when neither a default nor an allow-list is configured", () => {
    expect(isRegistrationOrgPermitted(other, { defaultOrg: undefined, allowList: [] })).toBe(true);
  });

  it("with only a default org, permits that org and REFUSES every other", () => {
    const policy = { defaultOrg: "acme", allowList: [] };
    expect(isRegistrationOrgPermitted(acme, policy)).toBe(true);
    expect(isRegistrationOrgPermitted(other, policy)).toBe(false);
  });

  it("matches the default by id as well as by slug, case-insensitively", () => {
    expect(
      isRegistrationOrgPermitted(acme, { defaultOrg: acme.id.toUpperCase(), allowList: [] }),
    ).toBe(true);
    expect(isRegistrationOrgPermitted(acme, { defaultOrg: " ACME ", allowList: [] })).toBe(true);
  });

  it("permits an allow-listed org alongside the default", () => {
    const policy = { defaultOrg: "acme", allowList: parseRegistrationOrgAllowList("other, x") };
    expect(isRegistrationOrgPermitted(other, policy)).toBe(true);
    expect(isRegistrationOrgPermitted({ id: "3", slug: "third" }, policy)).toBe(false);
  });

  it("an allow-list alone (no default) is also restrictive", () => {
    const policy = { defaultOrg: undefined, allowList: parseRegistrationOrgAllowList("acme") };
    expect(isRegistrationOrgPermitted(acme, policy)).toBe(true);
    expect(isRegistrationOrgPermitted(other, policy)).toBe(false);
  });

  it("parses the allow-list env: trims, lower-cases, drops empties", () => {
    expect(parseRegistrationOrgAllowList(undefined)).toEqual([]);
    expect(parseRegistrationOrgAllowList("")).toEqual([]);
    expect(parseRegistrationOrgAllowList(" Acme ,, other,")).toEqual(["acme", "other"]);
  });
});
