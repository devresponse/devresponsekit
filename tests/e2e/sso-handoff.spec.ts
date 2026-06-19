import { expect, test } from "@playwright/test";
import { ADMIN_API_HEADERS, signInAsSeedAdmin } from "./helpers/admin-auth";

/**
 * E2E — the cross-subdomain SSO handoff end to end against the real DB
 * (review F2 + P2-2): register a destination app, launch a one-time handoff
 * token, follow the consume GET to the confirmation interstitial (which does
 * NOT yet sign in), POST to confirm (which burns the `jti` and establishes the
 * session), then prove a REPLAY of the same token is rejected. This exercises
 * the real sign/verify/nonce-consume path that is otherwise mock-only, plus the
 * P2-2 confirmation step that defeats IdP-initiated login-CSRF.
 *
 * The launch signs the token with the app's `sso_audience`, and the consumer
 * checks it against this deployment's `SSO_HANDOFF_AUDIENCE_PREFIX` +
 * `SSO_HANDOFF_APPLICATION_ID` — so the registered app's audience must equal
 * that expected value for a single-instance round trip. CI's `browser` job
 * sets `SSO_HANDOFF_APPLICATION_ID=portal` and `SSO_HANDOFF_AUDIENCE_PREFIX=
 * devresponse-app`, hence the audience below.
 */
test.beforeEach(async ({ page }) => {
  await signInAsSeedAdmin(page);
});

test("sso handoff: launch -> consume -> replay rejected", async ({ page }, testInfo) => {
  const slug = `e2e-sso-${testInfo.project.name}-${Date.now()}`;
  const audience = "devresponse-app:portal";

  // Register the destination app. Its origin must fall under the configured
  // SSO_ALLOWED_ORIGIN_SUFFIXES (devresponse.com) — we only read the launch
  // redirect's token, never actually navigate to that host.
  const createRes = await page.request.post("/api/administrator/enterprise-apps", {
    headers: ADMIN_API_HEADERS,
    data: {
      id: slug,
      label: `E2E SSO ${slug}`,
      origin: `https://${slug}.devresponse.com`,
      subdomain: slug,
      sso_audience: audience,
      status: "available",
    },
  });
  expect(createRes.ok(), await createRes.text()).toBe(true);

  try {
    // LAUNCH — a 302 whose Location carries the one-time handoff token.
    const launchRes = await page.request.get(`/api/sso/launch?applicationId=${slug}`, {
      maxRedirects: 0,
    });
    // NextResponse.redirect() defaults to 307 (temporary, method-preserving).
    expect(launchRes.status(), await launchRes.text()).toBe(307);
    const location = launchRes.headers()["location"];
    expect(location, "launch should redirect to the consume URL").toContain(
      "/api/sso/consume?token=",
    );
    const token = new URL(location!).searchParams.get("token");
    expect(token, "launch redirect should carry a token").toBeTruthy();

    // CONSUME (GET) on this origin — verifies the token and redirects to the
    // localized confirmation interstitial. It does NOT burn the jti or sign in
    // yet (P2-2: a silent GET sign-in would enable login-CSRF).
    const consumeRes = await page.request.get(
      `/api/sso/consume?token=${encodeURIComponent(token!)}`,
      { maxRedirects: 0 },
    );
    expect(consumeRes.status(), await consumeRes.text()).toBe(307);
    expect(consumeRes.headers()["location"]).toContain("/sso/confirm");

    // CONFIRM (POST) — the interstitial's same-origin, trusted-origin-guarded
    // submit burns the jti, establishes the session, and 303s to the dashboard.
    const confirmRes = await page.request.post("/api/sso/consume", {
      form: { token: token! },
      headers: ADMIN_API_HEADERS,
      maxRedirects: 0,
    });
    expect(confirmRes.status(), await confirmRes.text()).toBe(303);
    expect(confirmRes.headers()["location"]).toContain("/app/dashboard");

    // REPLAY the same one-time token via POST — rejected, the jti is consumed.
    const replayRes = await page.request.post("/api/sso/consume", {
      form: { token: token! },
      headers: ADMIN_API_HEADERS,
      maxRedirects: 0,
    });
    expect(replayRes.status()).toBe(401);
  } finally {
    await page.request.delete(`/api/administrator/enterprise-apps/${slug}`, {
      headers: ADMIN_API_HEADERS,
    });
  }
});
