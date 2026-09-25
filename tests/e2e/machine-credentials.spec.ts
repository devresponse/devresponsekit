import { expect, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_API_HEADERS, SEED_ADMIN, signInAsSeedAdmin } from "./helpers/admin-auth";
import {
  addActiveMembership,
  createActiveUser,
  createOrganization,
  deleteMembership,
  deleteOrganization,
  findDefaultOrg,
  softDeleteUser,
  uniqueSuffix,
} from "./helpers/authz-fixtures";

/**
 * E2E — machine credentials end to end against the real DB. The route tests
 * mock the caller resolver and the Better Auth wrappers, so these journeys are
 * the only proof that a real bearer works:
 *
 *   - review F2: register an OAuth client, exchange it for a JWT access token,
 *     call a protected `/api/v1` endpoint with that bearer, revoke the client,
 *     and confirm it can no longer mint;
 *   - F-43: a bearer that MUTATES (create a user, change its status, ban and
 *     unban it). F-13 answered 502 to every bearer on those writes and stayed
 *     live because no e2e used a bearer to change anything;
 *   - F-43: the API-key journey (mint from the session, use, rotate, the old
 *     key refused);
 *   - F-43: a bearer bound to one org gets 404 for a user who exists only in
 *     another org (MACHINE-2), against the real resolver and access context.
 *
 * Requires the machine API (`API_JWT_ENABLED=1` + a signing key) and the API
 * key path (`API_KEYS_ENABLED=1`); CI sets all three in the `browser` job.
 */
test.beforeEach(async ({ page }) => {
  await signInAsSeedAdmin(page);
});

/**
 * The F-43 journeys are pure HTTP: the Pixel 7 project would repeat the same
 * calls, so they run once, in the desktop project.
 */
const API_ONLY = "API-only: the mobile project would repeat the same HTTP calls";

interface RegisteredClient {
  id: string;
  clientId: string;
  clientSecret: string;
}

/** `app_users.id` of the caller behind `api` (the seed admin's cookie). */
async function readAppUserId(api: APIRequestContext): Promise<string> {
  const res = await api.get("/api/v1/me");
  expect(res.ok(), await res.text()).toBe(true);
  const me = (await res.json()) as { appUserId: string };
  expect(me.appUserId).toBeTruthy();
  return me.appUserId;
}

/** Registers a client whose service principal is the caller; the secret is shown once. */
async function registerClient(
  api: APIRequestContext,
  input: { name: string; scopes: string[]; serviceAppUserId: string; organizationId: string },
): Promise<RegisteredClient> {
  const res = await api.post("/api/v1/admin/oauth-clients", {
    headers: ADMIN_API_HEADERS,
    data: input,
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as RegisteredClient;
}

/** Exchanges the client for a v1 access token (client-credentials grant). */
async function mintAccessToken(api: APIRequestContext, client: RegisteredClient): Promise<string> {
  const res = await api.post("/api/v1/auth/token", {
    data: {
      grant_type: "client_credentials",
      client_id: client.clientId,
      client_secret: client.clientSecret,
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const { access_token: token } = (await res.json()) as { access_token: string };
  expect(token).toBeTruthy();
  return token;
}

async function revokeClient(api: APIRequestContext, id: string): Promise<void> {
  const res = await api.delete(`/api/v1/admin/oauth-clients/${id}`, {
    headers: ADMIN_API_HEADERS,
  });
  expect(res.ok(), await res.text()).toBe(true);
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

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

/**
 * F-43 (F-13) — the JWT alone creates a user, approves it, then bans and
 * unbans it. Every status is asserted exactly: the regression this pins was a
 * 502 that a "not a 5xx" check would also have caught, but a 200 where a 201
 * belongs, or a 404 from a scope slip, would pass such a check.
 */
test("a client-credentials bearer creates, approves, bans and unbans a user (F-13)", async ({
  page,
  request,
  isMobile,
}, testInfo) => {
  test.skip(isMobile, API_ONLY);
  const api = page.request;
  const suffix = uniqueSuffix(testInfo);
  const org = await findDefaultOrg(api);
  const client = await registerClient(api, {
    name: `e2e-cc-mutate-${suffix}`,
    scopes: ["admin.users.read", "admin.users.create", "admin.users.manage", "admin.users.ban"],
    serviceAppUserId: await readAppUserId(api),
    organizationId: org.id,
  });

  const email = `e2e.bearer.create.${suffix}@devresponse.local`;
  let userId: string | undefined;
  try {
    // `request` is a cookieless context: from here on the token is the only
    // credential on the machine calls.
    const auth = bearer(await mintAccessToken(request, client));

    const createRes = await request.post("/api/v1/users", {
      headers: auth,
      data: { email, password: "E2e-BearerCreate-123!", name: "E2E Bearer Created" },
    });
    expect(createRes.status(), await createRes.text()).toBe(201);
    const created = (await createRes.json()) as { id: string; email: string; status: string };
    userId = created.id;
    expect(created).toMatchObject({ email, status: "pending_approval" });

    // Neither create route places the account in an organization, and a
    // credential bound to one org reaches only that org's users (ADR-0001,
    // MACHINE-2). The admin adds the membership, as an operator would.
    await addActiveMembership(api, created.id, org.id);

    const readBack = async () => {
      const res = await request.get(`/api/v1/users/${created.id}`, { headers: auth });
      expect(res.status(), await res.text()).toBe(200);
      return ((await res.json()) as { user: { primary_email: string; status: string } }).user;
    };
    expect(await readBack()).toMatchObject({ primary_email: email, status: "pending_approval" });

    const approveRes = await request.post(`/api/v1/users/${created.id}/status`, {
      headers: auth,
      data: { action: "approve" },
    });
    expect(approveRes.status(), await approveRes.text()).toBe(200);
    expect(await approveRes.json()).toEqual({ ok: true, status: "active" });
    expect((await readBack()).status).toBe("active");

    // The Better Auth-backed writes F-13 named, through the administrator
    // API, which admits the same bearer.
    const banRes = await request.post(`/api/administrator/users/${created.id}/ban`, {
      headers: auth,
      data: { reason: "e2e: bearer ban (F-13)" },
    });
    expect(banRes.status(), await banRes.text()).toBe(200);
    const unbanRes = await request.post(`/api/administrator/users/${created.id}/unban`, {
      headers: auth,
    });
    expect(unbanRes.status(), await unbanRes.text()).toBe(200);
  } finally {
    if (userId) await softDeleteUser(api, userId);
    await revokeClient(api, client.id);
  }
});

/**
 * F-43 — the API-key journey. The seed admin mints a `drk_` key from their
 * session, the key alone lists and creates users, a rotation hands back a
 * successor, and the OLD key is refused at once (401) while the new one works.
 * With `API_KEYS_ENABLED` unset every key is refused as `path_disabled`, which
 * is why CI's browser job sets it.
 */
test("API key: mint, list and create users with it, rotate, old key refused", async ({
  page,
  request,
  isMobile,
}, testInfo) => {
  test.skip(isMobile, API_ONLY);
  const api = page.request;
  const suffix = uniqueSuffix(testInfo);
  const scopes = ["admin.users.read", "admin.users.create"];

  // MINT from the cookie session: an ambient credential, so the mutation
  // carries an Origin like a browser would.
  const mintRes = await api.post("/api/v1/me/api-keys", {
    headers: ADMIN_API_HEADERS,
    data: { name: `e2e-key-${suffix}`, scopes, expiresInDays: 1 },
  });
  expect(mintRes.status(), await mintRes.text()).toBe(201);
  const minted = (await mintRes.json()) as { id: string; key: string; scopes: string[] };
  expect(minted.key).toMatch(/^drk_/);
  expect(minted.scopes).toHaveLength(scopes.length);
  expect(minted.scopes).toEqual(expect.arrayContaining(scopes));

  const listSeedAdmin = (key: string) =>
    request.get(`/api/v1/users?q=${encodeURIComponent(SEED_ADMIN.email)}&pageSize=5`, {
      headers: bearer(key),
    });

  let liveKeyId = minted.id;
  let userId: string | undefined;
  try {
    // LIST: the key is bound to the admin's org, where the admin is a member.
    const listRes = await listSeedAdmin(minted.key);
    expect(listRes.status(), await listRes.text()).toBe(200);
    const list = (await listRes.json()) as { items: { primary_email: string }[] };
    expect(list.items.map((u) => u.primary_email)).toContain(SEED_ADMIN.email.toLowerCase());

    // CREATE with the key alone.
    const email = `e2e.apikey.create.${suffix}@devresponse.local`;
    const createRes = await request.post("/api/v1/users", {
      headers: bearer(minted.key),
      data: { email, password: "E2e-ApiKeyCreate-123!", name: "E2E Api Key Created" },
    });
    expect(createRes.status(), await createRes.text()).toBe(201);
    const created = (await createRes.json()) as { id: string; email: string };
    userId = created.id;
    expect(created.email).toBe(email);

    // ROTATE: a successor with the same scopes; the old key is revoked in the
    // same transaction.
    const rotateRes = await api.post(`/api/v1/me/api-keys/${minted.id}/rotate`, {
      headers: ADMIN_API_HEADERS,
    });
    expect(rotateRes.status(), await rotateRes.text()).toBe(201);
    const rotated = (await rotateRes.json()) as { id: string; key: string; scopes: string[] };
    liveKeyId = rotated.id;
    expect(rotated.id).not.toBe(minted.id);
    expect(rotated.key).not.toBe(minted.key);
    expect(rotated.scopes).toEqual(minted.scopes);

    const oldKeyRes = await listSeedAdmin(minted.key);
    expect(oldKeyRes.status(), await oldKeyRes.text()).toBe(401);
    const newKeyRes = await listSeedAdmin(rotated.key);
    expect(newKeyRes.status(), await newKeyRes.text()).toBe(200);
  } finally {
    if (userId) await softDeleteUser(api, userId);
    const revokeRes = await api.delete(`/api/v1/me/api-keys/${liveKeyId}`, {
      headers: ADMIN_API_HEADERS,
    });
    expect(revokeRes.ok(), await revokeRes.text()).toBe(true);
  }
});

/**
 * F-43 (MACHINE-2) — the seed admin is a global superuser, and a credential
 * that borrows that identity must still act in the ONE org it is bound to. A
 * user who exists only in another org is a 404 to the bearer, the same answer
 * as an id that exists nowhere, and absent from its search. The same principal
 * at a browser (cross-org reach) reads that user with a 200, so the 404 is the
 * binding, not a missing row. The route tests stub the resolver and the DB;
 * this runs the real ones.
 */
test("a bearer bound to the default org gets 404 for a user who exists only in another org", async ({
  page,
  request,
  isMobile,
}, testInfo) => {
  test.skip(isMobile, API_ONLY);
  const api = page.request;
  const suffix = uniqueSuffix(testInfo);

  const orgA = await findDefaultOrg(api);
  const orgB = await createOrganization(api, `e2e-bearer-xorg-${suffix}`);
  const foreign = await createActiveUser(api, {
    email: `e2e.bearer.xorg.foreign.${suffix}@devresponse.local`,
    password: "E2e-BearerForeign-123!",
    name: "E2E Bearer Org B Only",
  });
  const foreignMembership = await addActiveMembership(api, foreign.id, orgB.id);
  const local = await createActiveUser(api, {
    email: `e2e.bearer.xorg.local.${suffix}@devresponse.local`,
    password: "E2e-BearerLocal-123!",
    name: "E2E Bearer Org A Member",
  });
  const localMembership = await addActiveMembership(api, local.id, orgA.id);
  const client = await registerClient(api, {
    name: `e2e-cc-xorg-${suffix}`,
    scopes: ["admin.users.read"],
    serviceAppUserId: await readAppUserId(api),
    organizationId: orgA.id,
  });

  try {
    const auth = bearer(await mintAccessToken(request, client));

    // Control: a user in the bound org is readable, so the 404s below are the
    // boundary and not a broken credential.
    const ownRes = await request.get(`/api/v1/users/${local.id}`, { headers: auth });
    expect(ownRes.status(), await ownRes.text()).toBe(200);

    const foreignRes = await request.get(`/api/v1/users/${foreign.id}`, { headers: auth });
    expect(foreignRes.status(), await foreignRes.text()).toBe(404);
    expect(await foreignRes.text()).not.toContain(foreign.email);

    const unknownRes = await request.get("/api/v1/users/00000000-0000-4000-8000-000000000000", {
      headers: auth,
    });
    expect(unknownRes.status(), await unknownRes.text()).toBe(404);

    // The list is confined the same way.
    const search = (email: string) =>
      request.get(`/api/v1/users?q=${encodeURIComponent(email)}`, { headers: auth });
    const foreignSearch = await search(foreign.email);
    expect(foreignSearch.status(), await foreignSearch.text()).toBe(200);
    expect(((await foreignSearch.json()) as { total: number }).total).toBe(0);
    const localSearch = await search(local.email);
    expect(localSearch.status(), await localSearch.text()).toBe(200);
    expect(((await localSearch.json()) as { total: number }).total).toBe(1);

    // The same principal's cookie session is a superadmin with cross-org
    // reach: it reads the foreign user, so the row exists.
    const cookieRes = await api.get(`/api/v1/users/${foreign.id}`);
    expect(cookieRes.status(), await cookieRes.text()).toBe(200);
  } finally {
    await revokeClient(api, client.id);
    await deleteMembership(api, foreign.id, foreignMembership);
    await deleteMembership(api, local.id, localMembership);
    await deleteOrganization(api, orgB.id);
    await softDeleteUser(api, foreign.id);
    await softDeleteUser(api, local.id);
  }
});
