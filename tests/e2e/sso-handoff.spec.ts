import { expect, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_API_HEADERS, SEED_ADMIN, signInAsSeedAdmin } from "./helpers/admin-auth";

/**
 * E2E — the cross-subdomain SSO handoff end to end against the real DB
 * (review F2 + P2-2): register a destination app, launch a one-time handoff
 * token, follow the consume GET to the confirmation interstitial (which does
 * NOT yet sign in), POST to confirm (which burns the `jti` and establishes the
 * session), then prove a REPLAY of the same token is rejected. This exercises
 * the real sign/verify/nonce-consume path that is otherwise mock-only, plus the
 * P2-2 confirmation step that defeats IdP-initiated login-CSRF.
 *
 * The consumer binds every token to THIS deployment (review #15): the token's
 * `aud` must equal `SSO_HANDOFF_AUDIENCE_PREFIX:SSO_HANDOFF_APPLICATION_ID`
 * AND its `targetApplicationId` must equal `SSO_HANDOFF_APPLICATION_ID`, and the
 * nonce burn is predicated on that id. For a single-instance round trip the
 * registered app's `id` must therefore BE the deployment's application id. CI's
 * `browser` job sets `SSO_HANDOFF_APPLICATION_ID=portal` and
 * `SSO_HANDOFF_AUDIENCE_PREFIX=devresponse-app`, hence the values below.
 *
 * Signing (review #5): the token is EdDSA-signed with the ephemeral
 * `SSO_HANDOFF_PRIVATE_KEY` CI mints at runtime; because `SSO_HANDOFF_ISSUER`
 * equals `BETTER_AUTH_URL` the deployment is a self-issuer and verifies against
 * its local key set — the same public key it serves at `/api/sso/jwks.json`.
 *
 * The last test (F-43) follows a SIGNED-OUT visitor from the launch link
 * through the sign-in form to the application's consume URL (#464).
 */
const APP_ID = "portal";
const AUDIENCE = "devresponse-app:portal";
const PORTAL_ORIGIN = "https://portal.devresponse.com";

test.beforeEach(async ({ page }) => {
  await signInAsSeedAdmin(page);
});

test("sso handoff: the public JWKS is served, cacheable, and carries no private material", async ({
  page,
}) => {
  const res = await page.request.get("/api/sso/jwks.json");
  expect(res.status(), await res.text()).toBe(200);
  expect(res.headers()["cache-control"]).toContain("max-age=300");
  const body = (await res.json()) as { keys: Record<string, unknown>[] };
  expect(body.keys.length).toBeGreaterThanOrEqual(1);
  for (const key of body.keys) {
    expect(key).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig" });
    expect(typeof key.kid).toBe("string");
    expect(key).not.toHaveProperty("d");
  }
});

/**
 * Ensures the destination app exists. The row's id is fixed (see above) and a
 * launched handoff leaves a nonce row referencing it, so the cleanup delete is
 * refused (`application_in_use`) and a previous test or project run may have
 * left the row behind — look it up first and only create when absent. Its
 * origin must fall under the configured SSO_ALLOWED_ORIGIN_SUFFIXES
 * (devresponse.com); no test here ever reaches that host.
 */
async function ensurePortalApp(api: APIRequestContext): Promise<void> {
  const existingRes = await api.get(`/api/administrator/enterprise-apps/${APP_ID}`, {
    headers: ADMIN_API_HEADERS,
  });
  if (existingRes.status() === 404) {
    const createRes = await api.post("/api/administrator/enterprise-apps", {
      headers: ADMIN_API_HEADERS,
      data: {
        id: APP_ID,
        label: "E2E SSO portal",
        origin: PORTAL_ORIGIN,
        subdomain: "portal",
        sso_audience: AUDIENCE,
        status: "available",
      },
    });
    expect(createRes.ok(), await createRes.text()).toBe(true);
  } else {
    expect(existingRes.ok(), await existingRes.text()).toBe(true);
    const existing = (await existingRes.json()) as { sso_audience: string; origin: string };
    expect(existing.sso_audience).toBe(AUDIENCE);
    expect(existing.origin).toBe(PORTAL_ORIGIN);
  }
}

/**
 * Best-effort cleanup: the nonce row a launch leaves references the app, so
 * this is normally refused with 409 application_in_use and the row persists
 * for the next run (handled by {@link ensurePortalApp}).
 */
async function tryDeletePortalApp(api: APIRequestContext): Promise<void> {
  await api.delete(`/api/administrator/enterprise-apps/${APP_ID}`, {
    headers: ADMIN_API_HEADERS,
  });
}

test("sso handoff: launch -> consume -> replay rejected", async ({ page }, testInfo) => {
  // We only read the launch redirect's token and consume it on THIS origin.
  await ensurePortalApp(page.request);

  const foreignSlug = `e2e-sso-foreign-${testInfo.project.name}-${Date.now()}`;
  try {
    // A SECOND app may not be registered with the same audience (review #15):
    // the catalog refuses it with 409 audience_taken, so no other app can be
    // set up to have its tokens accepted by this deployment.
    const dupRes = await page.request.post("/api/administrator/enterprise-apps", {
      headers: ADMIN_API_HEADERS,
      data: {
        id: foreignSlug,
        label: `E2E SSO foreign ${foreignSlug}`,
        origin: `https://${foreignSlug}.devresponse.com`,
        subdomain: foreignSlug,
        sso_audience: AUDIENCE,
        status: "available",
      },
    });
    expect(dupRes.status(), await dupRes.text()).toBe(409);
    expect((await dupRes.json()).error).toBe("audience_taken");

    // LAUNCH — a 302 whose Location carries the one-time handoff token.
    const launchRes = await page.request.get(`/api/sso/launch?applicationId=${APP_ID}`, {
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
    await tryDeletePortalApp(page.request);
  }
});

/**
 * The #464 continuation, signed in THROUGH THE FORM (F-43). A satellite's
 * application switcher links a signed-out visitor at `/api/sso/launch`, which
 * sends them to sign-in with `returnTo=/{locale}/sso/launch?…`. After the
 * visitor signs in, Better Auth must navigate to that trampoline, which
 * forwards to the launch endpoint, which, now that there is a session, mints
 * the handoff and redirects to the application's consume URL.
 * `anonymous-redirect.spec.ts` pins only the first hop, so a sign-in that lost
 * the return target (the #464 bug: the visitor landed on the dashboard) passed
 * every check.
 *
 * The chain ends on another host, and Playwright does not route a redirect's
 * target, so the browser's post-sign-in navigation is held at its FIRST url,
 * the trampoline, and the remaining hops are followed one at a time with the
 * same browser context's cookies (`maxRedirects: 0`). The test never contacts
 * the application's host.
 */
test("sso launch: a signed-out visitor signs in through the form and continues to the application (#464)", async ({
  page,
  browser,
}) => {
  await ensurePortalApp(page.request);

  const visitor = await browser.newContext();
  try {
    let heldAt: string | undefined;
    await visitor.route(
      (url) => url.pathname === "/en/sso/launch",
      async (route) => {
        heldAt = route.request().url();
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><title>held</title>",
        });
      },
    );
    const visitorPage = await visitor.newPage();

    const launchRes = await visitorPage.goto(`/api/sso/launch?applicationId=${APP_ID}&locale=en`);
    expect(launchRes?.status()).toBeLessThan(400);
    await expect(visitorPage).toHaveURL(
      /\/en\/sign-in\?returnTo=%2Fen%2Fsso%2Flaunch%3FapplicationId%3Dportal%26locale%3Den/,
    );
    // Submit only once hydrated: before that the form would submit natively.
    await visitorPage.waitForLoadState("networkidle");
    await visitorPage.getByLabel(/email/i).fill(SEED_ADMIN.email);
    await visitorPage.getByLabel(/^password/i).fill(SEED_ADMIN.password);
    await visitorPage.getByRole("button", { name: /^sign in$/i }).click();

    // Signing in continued to the trampoline, not to the dashboard.
    await visitorPage.waitForURL((url) => url.pathname === "/en/sso/launch", { timeout: 15_000 });
    expect(heldAt, "the post-sign-in navigation should reach the trampoline").toBeDefined();
    expect(new URL(heldAt!).search).toBe(`?applicationId=${APP_ID}&locale=en`);

    // Trampoline -> launch endpoint, as an HTTP redirect: a streamed render
    // would turn it into a meta refresh (the page's invariant 3).
    const trampolineRes = await visitor.request.get(heldAt!, { maxRedirects: 0 });
    expect(trampolineRes.status(), await trampolineRes.text()).toBe(307);
    const launchUrl = new URL(trampolineRes.headers()["location"]!, heldAt);
    expect(launchUrl.pathname + launchUrl.search).toBe(
      `/api/sso/launch?applicationId=${APP_ID}&locale=en`,
    );

    // Launch endpoint, now with the session the form created -> the
    // application's consume URL, carrying a one-time token.
    const signedInLaunchRes = await visitor.request.get(launchUrl.href, { maxRedirects: 0 });
    expect(signedInLaunchRes.status(), await signedInLaunchRes.text()).toBe(307);
    const consumeUrl = new URL(signedInLaunchRes.headers()["location"]!);
    expect(consumeUrl.origin).toBe(PORTAL_ORIGIN);
    expect(consumeUrl.pathname).toBe("/api/sso/consume");
    expect(consumeUrl.searchParams.get("token")).toBeTruthy();
  } finally {
    await visitor.close();
    await tryDeletePortalApp(page.request);
  }
});
