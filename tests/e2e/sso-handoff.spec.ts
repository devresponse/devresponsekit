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
 */
const APP_ID = "portal";
const AUDIENCE = "devresponse-app:portal";

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

test("sso handoff: launch -> consume -> replay rejected", async ({ page }, testInfo) => {
  // Ensure the destination app exists. The row's id is fixed (see above) and a
  // consumed handoff leaves a nonce row referencing it, so the cleanup delete
  // is refused (`application_in_use`) and a previous project run may have left
  // the row behind — look it up first and only create when absent. Its origin
  // must fall under the configured SSO_ALLOWED_ORIGIN_SUFFIXES
  // (devresponse.com) — we only read the launch redirect's token, never
  // actually navigate to that host.
  const existingRes = await page.request.get(`/api/administrator/enterprise-apps/${APP_ID}`, {
    headers: ADMIN_API_HEADERS,
  });
  if (existingRes.status() === 404) {
    const createRes = await page.request.post("/api/administrator/enterprise-apps", {
      headers: ADMIN_API_HEADERS,
      data: {
        id: APP_ID,
        label: "E2E SSO portal",
        origin: "https://portal.devresponse.com",
        subdomain: "portal",
        sso_audience: AUDIENCE,
        status: "available",
      },
    });
    expect(createRes.ok(), await createRes.text()).toBe(true);
  } else {
    expect(existingRes.ok(), await existingRes.text()).toBe(true);
    expect((await existingRes.json()).sso_audience).toBe(AUDIENCE);
  }

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
    // Best-effort cleanup: the consumed nonce row references the app, so this
    // is normally refused with 409 application_in_use and the row persists
    // for the next project run (handled by the lookup above).
    await page.request.delete(`/api/administrator/enterprise-apps/${APP_ID}`, {
      headers: ADMIN_API_HEADERS,
    });
  }
});
