import { expect, test } from "@playwright/test";
import { SEED_ADMIN } from "./helpers/admin-auth";

/**
 * E2E — sign-out revokes the session SERVER-SIDE (review #29). A replayed
 * copy of the pre-sign-out cookie must be refused by an authenticated
 * endpoint, not merely dropped by the browser: a stolen cookie is exactly a
 * copy the browser no longer holds. Driven against the real Better Auth
 * session store, so a future cookie-cache / stateless-session change that
 * kept honouring revoked cookies would fail here.
 */
test("a session cookie replayed after sign-out is refused with 401", async ({
  browser,
  playwright,
  baseURL,
}) => {
  // A dedicated context so the sign-out below cannot disturb another suite's
  // admin session, and so the jar holds ONLY the cookies this sign-in set.
  const context = await browser.newContext();
  let replay: Awaited<ReturnType<typeof playwright.request.newContext>> | undefined;
  try {
    const signIn = await context.request.post("/api/auth/sign-in/email", {
      data: { email: SEED_ADMIN.email, password: SEED_ADMIN.password },
    });
    expect(signIn.ok(), await signIn.text()).toBe(true);

    // Capture the cookie jar as a raw Cookie header — the "stolen copy".
    const cookies = await context.cookies();
    expect(cookies.length, "sign-in should have set at least one cookie").toBeGreaterThan(0);
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    // The replay context is cookieless apart from the captured header, so its
    // outcome depends on the server's view of THAT cookie alone.
    replay = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { cookie: cookieHeader },
    });

    // Control: before sign-out the copy authenticates as the admin.
    const before = await replay.get("/api/v1/me");
    expect(before.status(), await before.text()).toBe(200);
    expect(((await before.json()) as { email: string }).email).toBe(SEED_ADMIN.email);

    // Sign out from the ORIGINAL context (the browser's own jar). Better Auth
    // insists on a JSON content type even for an empty body.
    const signOut = await context.request.post("/api/auth/sign-out", {
      headers: { origin: new URL(baseURL ?? "http://localhost:3000").origin },
      data: {},
    });
    expect(signOut.ok(), await signOut.text()).toBe(true);

    // The copy is now dead: 401, and no identity leaks in the body.
    const after = await replay.get("/api/v1/me");
    expect(after.status(), await after.text()).toBe(401);
    expect(await after.text()).not.toContain(SEED_ADMIN.email);

    // And the original jar is signed out as well (belt and braces — a
    // client-only sign-out that cleared the cookie but kept the row alive
    // would already have failed the replay assertion above).
    const original = await context.request.get("/api/v1/me");
    expect(original.status()).toBe(401);
  } finally {
    await replay?.dispose();
    await context.close();
  }
});
