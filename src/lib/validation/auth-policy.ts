import { z } from "zod";

/**
 * Shared validation for the per-organization signup policy
 * (`app_organization_auth_settings`). Imported by BOTH the
 * API routes (`/api/administrator/organizations/[id]/auth-settings`,
 * `/api/administrator/auth-settings/defaults`) and the client form so the
 * two enforce identical rules. Error messages are stable `validation.*`
 * i18n keys.
 *
 * The enums are duplicated from `auth-policy.server.ts` (rather than
 * imported) because this module is bundled to the client and that one is
 * `server-only`; `tests/unit/auth-policy-validation.test.ts` pins them to
 * the server module so they cannot drift.
 */
export const AUTH_POLICY_METHODS = ["email", "google", "microsoft", "github"] as const;
export const AUTH_POLICY_APPROVAL_MODES = ["admin_approval", "auto_active", "invite_only"] as const;

export type AuthPolicyMethod = (typeof AUTH_POLICY_METHODS)[number];
export type AuthPolicyApprovalMode = (typeof AUTH_POLICY_APPROVAL_MODES)[number];

/**
 * One lowercase DNS-ish email domain: dot-separated labels of alphanumerics
 * and inner hyphens (`acme.com`, `mail.acme-corp.co.uk`). Deliberately
 * requires at least one dot — a bare TLD auto-approve rule is always a
 * configuration mistake.
 */
export const EMAIL_DOMAIN_RE =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Wire contract for PATCH: a COMPLETE policy (no partial update — an org row
 * either exists in full or the org inherits the platform default; see 0007).
 * `null` array semantics: `allowedAuthMethods` null = every enabled method;
 * `autoApproveEmailDomains` null = no domain auto-approval. An EMPTY
 * `allowedAuthMethods` is legal and means "no new sign-ups auto-place here"
 * (every method parks in pending_approval).
 */
/**
 * Refinement predicate: is the (verification, domains) combination allowed?
 * `true` when verification is on OR there are no auto-approve domains.
 *
 * Domain auto-approval and waived verification are mutually exclusive: with
 * verification off, an email/password address is never proven, so a domain
 * rule would auto-activate anyone claiming that domain (the sign-up hook
 * stamps `emailVerified: true` without proof). Reject the combination so an
 * admin can't create it — the security guarantee behind `autoApproveEmailDomains`
 * is "VERIFIED addresses only". Mirrored by the fail-closed guard in
 * `decideInitialStatus`.
 */
function isDomainVerificationComboValid(input: {
  requireEmailVerification: boolean;
  autoApproveEmailDomains?: string[] | null;
}): boolean {
  return input.requireEmailVerification || !input.autoApproveEmailDomains?.length;
}

export const authPolicySettingsSchema = z
  .object({
    requireEmailVerification: z.boolean(),
    signupApprovalMode: z.enum(AUTH_POLICY_APPROVAL_MODES),
    allowedAuthMethods: z.array(z.enum(AUTH_POLICY_METHODS)).max(4).nullable(),
    autoApproveEmailDomains: z
      .array(z.string().min(1, "required").max(255, "max").regex(EMAIL_DOMAIN_RE, "domainList"))
      .max(50, "max")
      .nullable(),
  })
  .strict()
  .refine(isDomainVerificationComboValid, {
    message: "domainsNeedVerification",
    path: ["autoApproveEmailDomains"],
  });

export type AuthPolicySettingsInput = z.input<typeof authPolicySettingsSchema>;

/**
 * Parses the form's free-text domain list (comma / whitespace separated)
 * into normalized (trimmed, lowercased, deduped) domains. `invalid` carries
 * the tokens that failed `EMAIL_DOMAIN_RE` so the form can name them.
 */
export function parseEmailDomainList(text: string): { domains: string[]; invalid: string[] } {
  const tokens = text
    .split(/[\s,;]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const domains: string[] = [];
  const invalid: string[] = [];
  for (const token of tokens) {
    if (!EMAIL_DOMAIN_RE.test(token)) {
      invalid.push(token);
      continue;
    }
    if (!domains.includes(token)) {
      domains.push(token);
    }
  }
  return { domains, invalid };
}

/**
 * Client-form view of the policy. Methods are modeled as a restrict toggle +
 * a picked subset (the API's `null` = unrestricted); domains as free text
 * (validated token-wise via {@link parseEmailDomainList}).
 */
export const authPolicyFormSchema = z
  .object({
    requireEmailVerification: z.boolean(),
    signupApprovalMode: z.enum(AUTH_POLICY_APPROVAL_MODES),
    restrictMethods: z.boolean(),
    allowedAuthMethods: z.array(z.enum(AUTH_POLICY_METHODS)),
    autoApproveEmailDomainsText: z
      .string()
      .max(2000, "max")
      .refine((v) => parseEmailDomainList(v).invalid.length === 0, "domainList"),
  })
  .strict()
  .refine(
    (v) =>
      isDomainVerificationComboValid({
        requireEmailVerification: v.requireEmailVerification,
        autoApproveEmailDomains: parseEmailDomainList(v.autoApproveEmailDomainsText).domains,
      }),
    { message: "domainsNeedVerification", path: ["autoApproveEmailDomainsText"] },
  );

export type AuthPolicyFormInput = z.input<typeof authPolicyFormSchema>;

/** Converts the form view to the wire contract. */
export function toAuthPolicyApiBody(values: AuthPolicyFormInput): AuthPolicySettingsInput {
  const { domains } = parseEmailDomainList(values.autoApproveEmailDomainsText);
  return {
    requireEmailVerification: values.requireEmailVerification,
    signupApprovalMode: values.signupApprovalMode,
    allowedAuthMethods: values.restrictMethods ? [...new Set(values.allowedAuthMethods)] : null,
    autoApproveEmailDomains: domains.length > 0 ? domains : null,
  };
}
