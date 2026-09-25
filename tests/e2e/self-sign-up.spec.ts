import { expect, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_API_HEADERS, signInAsSeedAdmin } from "./helpers/admin-auth";
import { findDefaultOrg, softDeleteUser, uniqueSuffix } from "./helpers/authz-fixtures";
import { readOutboxDeliveryLink } from "./helpers/outbox-db";

/**
 * E2E — self sign-up end to end (F-43): the sign-up form, the "check your
 * inbox" screen, the verification link as emailed, the "email verified"
 * screen, sign-in through the form, and the page the organization's sign-up
 * policy decides. Before this spec only the invitation sign-up had an e2e, so
 * a regression in the verification gate (an unverified account that can sign
 * in, a link that does not verify) or in where a self-registered account lands
 * passed every required check.
 *
 * An unmapped sign-up is placed in THE default organization (`is_default`,
 * F-40), and that org's EFFECTIVE policy decides active vs pending. CI's seed
 * sets the platform default to `auto_active` with verification required
 * (`seedPlatformSignupPolicy`), which the default org inherits, so in CI the
 * journey ends on the dashboard. The expectation is read from the org's
 * effective policy rather than hard-coded, so a local database whose
 * administrator chose `admin_approval` runs the pending-approval branch.
 *
 * The verification link comes from the outbox row's DB-only delivery payload:
 * the admin API serves outbox bodies redacted (review #21). CI configures no
 * email provider, so the row is recorded as `logged` and never sent.
 */
interface EffectivePolicy {
  requireEmailVerification: boolean;
  signupApprovalMode: "admin_approval" | "auto_active" | "invite_only";
  allowedAuthMethods: string[] | null;
}

async function findUserIdByEmail(
  api: APIRequestContext,
  email: string,
): Promise<string | undefined> {
  const res = await api.get(`/api/administrator/users?q=${encodeURIComponent(email)}`);
  expect(res.ok(), await res.text()).toBe(true);
  const body = (await res.json()) as { items: { id: string; primary_email: string }[] };
  return body.items.find((u) => u.primary_email === email)?.id;
}

test("self sign-up: verify the emailed link, sign in, land where the org's policy decides", async ({
  page,
  browser,
}, testInfo) => {
  await signInAsSeedAdmin(page);
  const api = page.request;
  const org = await findDefaultOrg(api);

  const policyRes = await api.get(`/api/administrator/organizations/${org.id}/auth-settings`);
  expect(policyRes.status(), await policyRes.text()).toBe(200);
  const { effective } = (await policyRes.json()) as { effective: EffectivePolicy };
  // This is the verify-then-sign-in journey. A policy that waives
  // verification signs the account in straight from the sign-up form.
  expect(effective.requireEmailVerification, "the default org should require verification").toBe(
    true,
  );
  const landsActive =
    effective.signupApprovalMode === "auto_active" &&
    (effective.allowedAuthMethods === null || effective.allowedAuthMethods.includes("email"));

  const email = `e2e.signup.${uniqueSuffix(testInfo)}@devresponse.local`;
  const password = "E2e-SelfSignUp-123!";
  const visitor = await browser.newContext();
  try {
    const userPage = await visitor.newPage();
    await userPage.goto("/en/sign-up");
    // Submit only once hydrated: before that the form would submit natively.
    await userPage.waitForLoadState("networkidle");
    await userPage.getByLabel(/^name/i).fill("E2E Self Sign Up");
    await userPage.getByLabel(/email/i).fill(email);
    await userPage.getByLabel(/password/i).fill(password);
    await userPage.getByRole("button", { name: /^create account$/i }).click();

    // No session yet: the form sends the visitor to the "check your inbox" screen.
    await userPage.waitForURL(/\/en\/verify-email$/, { timeout: 15_000 });
    await expect(
      userPage.getByRole("heading", { level: 3, name: "Verify your email" }),
    ).toBeVisible();

    // The gate itself (AUTH-4), in two halves. Sign-up issued no session...
    const hasSession = async () =>
      (await visitor.cookies()).some((c) => c.name.endsWith("session_token"));
    expect(await hasSession(), "sign-up should not start a session").toBe(false);
    // ...and the right password does not sign an unverified account in. The
    // request carries a trusted Origin, as the browser's would, so Better
    // Auth's origin check cannot answer it instead: that check refuses an
    // Origin-less POST with a 403 of its own (MISSING_OR_NULL_ORIGIN) as soon
    // as the context holds a cookie. Hence the reason is pinned, not just the
    // status, as the sign-in form itself matches on it.
    const early = await visitor.request.post("/api/auth/sign-in/email", {
      headers: ADMIN_API_HEADERS,
      data: { email, password },
    });
    const earlyText = await early.text();
    expect(early.status(), earlyText).toBe(403);
    expect((JSON.parse(earlyText) as { code?: string }).code, earlyText).toBe("EMAIL_NOT_VERIFIED");
    expect(await hasSession(), "a refused sign-in should not start a session").toBe(false);

    // The link as emailed. The text body carries it raw; the HTML body would
    // carry it with `&amp;`, so that is undone in case the text body is empty.
    let verifyLink: string | undefined;
    await expect
      .poll(
        async () => {
          verifyLink = await readOutboxDeliveryLink({
            to: email,
            templateKey: "email_verification",
            pattern: /https?:\/\/[^\s"<]+\/verify-email\?[^\s"<]+/,
          });
          return Boolean(verifyLink);
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    const verifyUrl = new URL(verifyLink!.replace(/&amp;/g, "&"));
    expect(verifyUrl.pathname).toBe("/api/auth/verify-email");

    // Following it verifies the address and lands on the confirmation screen,
    // still without a session (`autoSignInAfterVerification` is off). A bad
    // token lands there too, with `?error=`, so that is ruled out explicitly.
    await userPage.goto(verifyUrl.pathname + verifyUrl.search);
    await userPage.waitForURL(/\/en\/verify-email\/confirmed/, { timeout: 15_000 });
    expect(new URL(userPage.url()).searchParams.get("error")).toBeNull();
    await expect(userPage.getByRole("heading", { level: 3, name: "Email verified" })).toBeVisible();

    await userPage.getByRole("link", { name: /proceed to sign in/i }).click();
    await userPage.waitForURL(/\/en\/sign-in/);
    await userPage.waitForLoadState("networkidle");
    await userPage.getByLabel(/email/i).fill(email);
    await userPage.getByLabel(/^password/i).fill(password);
    await userPage.getByRole("button", { name: /^sign in$/i }).click();

    if (landsActive) {
      await expect(userPage).toHaveURL(/\/en\/app\/dashboard/, { timeout: 15_000 });
      await expect(userPage.getByRole("banner", { name: /brand/i })).toBeVisible();
    } else {
      await expect(userPage).toHaveURL(/\/en\/pending-approval/, { timeout: 15_000 });
      await expect(
        userPage.getByRole("heading", { level: 3, name: "Your account is pending approval" }),
      ).toBeVisible();
    }

    // Placement (F-40): one membership, in THE default org, with the status
    // the policy decided, and the account status to match.
    const userId = await findUserIdByEmail(api, email);
    expect(userId, `an app user should exist for ${email}`).toBeDefined();
    const expectedStatus = landsActive ? "active" : "pending_approval";
    const userRes = await api.get(`/api/administrator/users/${userId}`);
    expect(userRes.status(), await userRes.text()).toBe(200);
    expect(((await userRes.json()) as { user: { status: string } }).user.status).toBe(
      expectedStatus,
    );
    const membershipsRes = await api.get(`/api/administrator/users/${userId}/memberships`);
    expect(membershipsRes.status(), await membershipsRes.text()).toBe(200);
    const memberships = (
      (await membershipsRes.json()) as { items: { organization_id: string; status: string }[] }
    ).items;
    expect(memberships).toEqual([
      expect.objectContaining({ organization_id: org.id, status: expectedStatus }),
    ]);
  } finally {
    await visitor.close();
    const userId = await findUserIdByEmail(api, email);
    if (userId) await softDeleteUser(api, userId);
  }
});
