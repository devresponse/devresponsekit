// End-to-end verification of the LOCAL subdomain-SSO rig
// (docs/integration-satellite-apps.md §6.6). Drives a real Chromium through
// every flow and exits non-zero on the first failure:
//
//   1. sign in on the primary          http://devresponse.local:3000
//   2. handoff to A + replay-reject    http://app1.devresponse.local:3001
//   3. handoff to B + replay-reject    http://app2.devresponse.local:3002
//   4. shared session on C (no SSO)    http://app3.devresponse.local:3003
//   5. session-cookie isolation report
//
// Prereqs: the four dev servers running (§6.6 step 5), the dev fixture seeded
// (`pnpm db:seed:dev`), and the hosts entries (scripts/setup-local-subdomains.ps1)
// — though the browser side also carries a resolver override so only the
// SERVERS strictly need the hosts file.
//
// Run:  node scripts/verify-local-sso.mjs
import { chromium } from "@playwright/test";

const PRIMARY = "http://devresponse.local:3000";
const APPS = {
  standalone: { host: "app1.devresponse.local", port: 3001 },
  handoff: { host: "app2.devresponse.local", port: 3002 },
};
const SHARED = "http://app3.devresponse.local:3003";
const USER = process.env.SSO_VERIFY_EMAIL ?? "superuser@orga.local";
const PASSWORD = process.env.SSO_VERIFY_PASSWORD ?? "DevPassword123!";

const log = (...a) => console.log("[verify-local-sso]", ...a);

const browser = await chromium.launch({
  args: ["--host-resolver-rules=MAP *.devresponse.local 127.0.0.1"],
});
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.setDefaultTimeout(60_000);

try {
  // 1. Sign in on the primary through the real form.
  await page.goto(`${PRIMARY}/en/sign-in`);
  await page.getByRole("textbox", { name: /email/i }).fill(USER);
  await page.getByRole("textbox", { name: /password/i }).fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => u.href.startsWith(`${PRIMARY}/en/app`));
  log("PRIMARY: signed in as", USER, "→", page.url());

  // 2–3. The handoff satellites: launch → confirm → dashboard → replay reject.
  for (const [appId, { host }] of Object.entries(APPS)) {
    await page.goto(`${PRIMARY}/api/sso/launch?applicationId=${appId}`);
    await page.waitForURL((u) => u.hostname === host && u.pathname.includes("/sso/confirm"));
    const token = new URL(page.url()).searchParams.get("token");
    const confirmText = await page.locator("main").innerText();
    if (!confirmText.includes(USER))
      throw new Error(`${appId}: confirm page does not show ${USER}`);
    log(`${appId.toUpperCase()}: confirm page on ${host} shows the account`);

    await page.getByRole("button", { name: /continue/i }).click();
    await page.waitForURL((u) => u.hostname === host && u.pathname.includes("/app/dashboard"));
    log(`${appId.toUpperCase()}: signed in →`, page.url());

    const replay = await page.evaluate(async (tok) => {
      const r = await fetch("/api/sso/consume", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tok }),
      });
      return r.status;
    }, token);
    if (replay !== 401) throw new Error(`${appId}: token replay returned ${replay}, expected 401`);
    log(`${appId.toUpperCase()}: replayed token rejected (401) — single-use OK`);
  }

  // 4. Option C: the parent-domain cookie signs it in with zero redirects.
  await page.goto(`${SHARED}/en/app/dashboard`);
  await page.waitForLoadState("networkidle");
  if (!page.url().startsWith(`${SHARED}/en/app/dashboard`)) {
    throw new Error(`C: expected the dashboard, landed on ${page.url()}`);
  }
  log("C (shared): dashboard rendered with the primary's session — zero redirects");

  // 5. Cookie isolation: A/B own their host; primary + C share .devresponse.local.
  const sessions = (await ctx.cookies())
    .filter((c) => c.name.includes("session_token"))
    .map((c) => `${c.domain} → ${c.name}=${c.value.slice(0, 8)}…`);
  log("session cookies:");
  for (const s of sessions) log("  ", s);

  log("ALL FLOWS PASSED");
} finally {
  await browser.close();
}
