import { expect, test } from "@playwright/test";
import { ADMIN_API_HEADERS, signInAsSeedAdmin } from "./helpers/admin-auth";

/**
 * E2E — the client-credentials machine flow end to end against the real DB
 * (review F2): register an OAuth client, exchange it for a JWT access token,
 * call a protected `/api/v1` endpoint with that bearer token, revoke the
 * client, and confirm it can no longer mint. The whole chain
 * (`oauth-clients.server` + `jwt.server` + the v1 guard + revocation) is
 * mock-only otherwise.
 *
 * Requires the machine API to be enabled (`API_JWT_ENABLED=1` + a signing
 * key) — CI sets both in the `browser` job.
 */
test.beforeEach(async ({ page }) => {
  await signInAsSeedAdmin(page);
});

test("client-credentials: mint -> call -> revoke", async ({ page, request }, testInfo) => {
  // The seeded admin owns the client (its service principal). /api/v1/me works
  // for the cookie session and yields the app_user id we need.
  const meRes = await page.request.get("/api/v1/me");
  expect(meRes.ok(), await meRes.text()).toBe(true);
  const me = (await meRes.json()) as { appUserId: string };
  expect(me.appUserId).toBeTruthy();

  // Register a machine identity. The client secret is returned exactly ONCE.
  const name = `e2e-cc-${testInfo.project.name}-${Date.now()}`;
  const createRes = await page.request.post("/api/v1/admin/oauth-clients", {
    headers: ADMIN_API_HEADERS,
    data: { name, scopes: ["admin.clients.read"], serviceAppUserId: me.appUserId },
  });
  expect(createRes.status(), await createRes.text()).toBe(201);
  const client = (await createRes.json()) as {
    id: string;
    clientId: string;
    clientSecret: string;
  };
  expect(client.clientId).toBeTruthy();
  expect(client.clientSecret).toBeTruthy();

  const mint = () =>
    page.request.post("/api/v1/auth/token", {
      data: {
        grant_type: "client_credentials",
        client_id: client.clientId,
        client_secret: client.clientSecret,
      },
    });

  try {
    // Mint a short-lived JWT from the credential.
    const tokenRes = await mint();
    expect(tokenRes.ok(), await tokenRes.text()).toBe(true);
    const token = (await tokenRes.json()) as { access_token: string; token_type: string };
    expect(token.token_type).toBe("Bearer");
    expect(token.access_token).toBeTruthy();

    // CALL a protected endpoint with ONLY the bearer token. The `request`
    // fixture is a separate, cookieless context, so a 200 here proves the
    // token itself authenticated + authorized (not the admin session cookie).
    const callRes = await request.get("/api/v1/admin/oauth-clients", {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    expect(callRes.ok(), await callRes.text()).toBe(true);
  } finally {
    // REVOKE the client.
    const revokeRes = await page.request.delete(`/api/v1/admin/oauth-clients/${client.id}`, {
      headers: ADMIN_API_HEADERS,
    });
    expect(revokeRes.ok(), await revokeRes.text()).toBe(true);
  }

  // A revoked client can no longer mint — 401 invalid_client.
  const afterRevoke = await mint();
  expect(afterRevoke.status()).toBe(401);
});
