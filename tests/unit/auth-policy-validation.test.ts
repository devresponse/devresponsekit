import { describe, expect, it } from "vitest";
import type { AuthMethod, SignupApprovalMode } from "@/lib/auth-policy.server";
import {
  AUTH_POLICY_APPROVAL_MODES,
  AUTH_POLICY_METHODS,
  authPolicySettingsSchema,
  parseEmailDomainList,
  toAuthPolicyApiBody,
} from "@/lib/validation/auth-policy";

/**
 * Unit tests for the shared signup-policy validation (0007). The enum
 * parity assignments below are the compile-time guard promised in the
 * module doc: if the client-safe constants drift from the server-only
 * `auth-policy.server.ts` unions, `pnpm typecheck` fails here.
 */
const _methodParity: readonly AuthMethod[] = AUTH_POLICY_METHODS;
const _modeParity: readonly SignupApprovalMode[] = AUTH_POLICY_APPROVAL_MODES;
void _methodParity;
void _modeParity;

describe("authPolicySettingsSchema", () => {
  const valid = {
    requireEmailVerification: true,
    signupApprovalMode: "admin_approval",
    allowedAuthMethods: null,
    autoApproveEmailDomains: null,
  };

  it("accepts a strict-default policy and every method/mode value", () => {
    expect(authPolicySettingsSchema.safeParse(valid).success).toBe(true);
    for (const mode of AUTH_POLICY_APPROVAL_MODES) {
      expect(
        authPolicySettingsSchema.safeParse({ ...valid, signupApprovalMode: mode }).success,
      ).toBe(true);
    }
    expect(
      authPolicySettingsSchema.safeParse({
        ...valid,
        allowedAuthMethods: [...AUTH_POLICY_METHODS],
        autoApproveEmailDomains: ["acme.com", "mail.acme-corp.co.uk"],
      }).success,
    ).toBe(true);
  });

  it("accepts an EMPTY method list (a closed org) but rejects unknown members", () => {
    expect(authPolicySettingsSchema.safeParse({ ...valid, allowedAuthMethods: [] }).success).toBe(
      true,
    );
    expect(
      authPolicySettingsSchema.safeParse({ ...valid, allowedAuthMethods: ["carrier-pigeon"] })
        .success,
    ).toBe(false);
  });

  it("rejects malformed domains, bare TLDs, and partial bodies", () => {
    for (const domain of ["not a domain", "acme", "-x.com", "x-.com", "http://acme.com"]) {
      expect(
        authPolicySettingsSchema.safeParse({ ...valid, autoApproveEmailDomains: [domain] }).success,
      ).toBe(false);
    }
    expect(authPolicySettingsSchema.safeParse({ requireEmailVerification: true }).success).toBe(
      false,
    );
    expect(authPolicySettingsSchema.safeParse({ ...valid, extraField: 1 }).success).toBe(false);
  });
});

describe("parseEmailDomainList", () => {
  it("normalizes, dedupes, and splits on commas/whitespace/semicolons", () => {
    expect(parseEmailDomainList(" Acme.COM,  acme.com ;\n mail.acme.com ")).toEqual({
      domains: ["acme.com", "mail.acme.com"],
      invalid: [],
    });
  });

  it("reports invalid tokens without dropping valid ones", () => {
    expect(parseEmailDomainList("acme.com, nope_domain, x")).toEqual({
      domains: ["acme.com"],
      invalid: ["nope_domain", "x"],
    });
  });

  it("returns empty lists for blank input", () => {
    expect(parseEmailDomainList("   ")).toEqual({ domains: [], invalid: [] });
  });
});

describe("toAuthPolicyApiBody", () => {
  const form = {
    requireEmailVerification: false,
    signupApprovalMode: "auto_active" as const,
    restrictMethods: false,
    allowedAuthMethods: ["email" as const, "email" as const, "google" as const],
    autoApproveEmailDomainsText: "",
  };

  it("maps unrestricted methods to null and blank domains to null", () => {
    expect(toAuthPolicyApiBody(form)).toEqual({
      requireEmailVerification: false,
      signupApprovalMode: "auto_active",
      allowedAuthMethods: null,
      autoApproveEmailDomains: null,
    });
  });

  it("dedupes the picked methods and parses the domain text when restricting", () => {
    expect(
      toAuthPolicyApiBody({
        ...form,
        restrictMethods: true,
        autoApproveEmailDomainsText: "Acme.com, acme.com",
      }),
    ).toEqual({
      requireEmailVerification: false,
      signupApprovalMode: "auto_active",
      allowedAuthMethods: ["email", "google"],
      autoApproveEmailDomains: ["acme.com"],
    });
  });
});
