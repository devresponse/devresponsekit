// Screenshot capture for the in-app help walkthrough (help/*.md +
// help/screenshots/). Produces 1440x900 PNGs in help/screenshots/.
//
// This is OPERATOR TOOLING, not servable help content: the help viewer serves
// only *.md and images, and .dockerignore keeps this file out of the runtime
// image. It holds NO credentials — everything it needs comes from the
// environment and it exits early (non-zero) when something is missing:
//
//   CAPTURE_BASE_URL   origin to capture, e.g. https://demo.example.com
//   CAPTURE_EMAIL      account to sign in as (needs the admin-console
//                      permissions for the /administrator screens)
//   CAPTURE_PASSWORD   that account's password — inject it from a secret
//                      store; never paste it into a script or a commit
//   CAPTURE_USER_ID    (optional) ids of the representative user / role /
//   CAPTURE_ROLE_ID    organization whose detail pages are captured; the
//   CAPTURE_ORG_ID     defaults are the public demo tenant's rows
//
// Run from the repo root (uses the repo's Playwright):
//   CAPTURE_BASE_URL=... CAPTURE_EMAIL=... CAPTURE_PASSWORD=... node help/capture.mjs
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/** Reads a required setting from the environment or exits with a clear message. */
function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(
      `help/capture.mjs: missing required environment variable ${name}. ` +
        "Set CAPTURE_BASE_URL, CAPTURE_EMAIL and CAPTURE_PASSWORD (see the header of this file).",
    );
    process.exit(2);
  }
  return value;
}

const BASE = new URL(requireEnv("CAPTURE_BASE_URL")).origin;
const EMAIL = requireEnv("CAPTURE_EMAIL");
const PASSWORD = requireEnv("CAPTURE_PASSWORD");
const USER_ID = process.env.CAPTURE_USER_ID?.trim() || "1ac53f53-dcae-4658-bde3-fd2166fb5d97";
const ROLE_ID = process.env.CAPTURE_ROLE_ID?.trim() || "c02b9969-bacf-44e6-8ede-d84405121b3a";
const ORG_ID = process.env.CAPTURE_ORG_ID?.trim() || "3a24bf3a-e9cc-45db-b910-a2237aebd6dd";
const OUT = path.join("help", "screenshots");

// [slug, route, options]
// extraScrolls: N additional shots, each after scrolling ~650px further down.
// settleMs: extra wait for pages with slow/streamed content (or stuck loaders).
const PUBLIC_SHOTS = [
  ["01-landing", "/en", { extraScrolls: 3 }],
  ["02-sign-in", "/en/sign-in"],
  ["03-sign-up", "/en/sign-up"],
  ["04-forgot-password", "/en/forgot-password"],
];

const APP_SHOTS = [
  ["10-dashboard", "/en/app/dashboard"],
  ["11-workspace", "/en/app/workspace"],
  ["12-account-overview", "/en/app/account", { extraScrolls: 1 }],
  ["13-account-profile", "/en/app/account/profile"],
  ["14-account-preferences", "/en/app/account/preferences"],
  ["15-account-security", "/en/app/account/security"],
  ["16-account-api-keys", "/en/app/account/api-keys", { extraScrolls: 1 }],
  ["17-docs-catalog", "/en/app/docs"],
  ["18-docs-architecture", "/en/app/docs/architecture", { extraScrolls: 1, settleMs: 2500 }],
  ["30-admin-overview", "/en/app/administrator", { extraScrolls: 2 }],
  ["31-admin-users", "/en/app/administrator/users"],
  ["32-admin-user-detail", `/en/app/administrator/users/${USER_ID}`],
  ["33-admin-user-create", "/en/app/administrator/users/new"],
  ["34-admin-roles", "/en/app/administrator/roles"],
  ["35-admin-role-detail", `/en/app/administrator/roles/${ROLE_ID}`, { extraScrolls: 1 }],
  ["36-admin-permissions", "/en/app/administrator/permissions", { extraScrolls: 1 }],
  ["37-admin-groups", "/en/app/administrator/groups"],
  ["38-admin-organizations", "/en/app/administrator/organizations", { extraScrolls: 1 }],
  ["39-admin-org-detail", `/en/app/administrator/organizations/${ORG_ID}`],
  ["40-admin-memberships", "/en/app/administrator/memberships"],
  ["41-admin-enterprise-apps", "/en/app/administrator/enterprise-apps"],
  ["42-admin-api-keys", "/en/app/administrator/api-keys"],
  ["43-admin-agents", "/en/app/administrator/agents"],
  // These three load client-side data; give them extra settle time.
  ["44-admin-email-outbox", "/en/app/administrator/email", { settleMs: 6000 }],
  ["45-admin-email-templates", "/en/app/administrator/email/templates", { settleMs: 6000 }],
  ["46-admin-audit", "/en/app/administrator/audit", { settleMs: 6000 }],
];

async function settle(page, opts = {}) {
  await page.waitForSelector("h1", { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(opts.settleMs ?? 1200);
}

async function shoot(page, slug, route, opts = {}) {
  await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await settle(page, opts);
  await page.screenshot({ path: path.join(OUT, `${slug}.png`) });
  console.log(`ok  ${slug}  ${route}`);
  for (let i = 0; i < (opts.extraScrolls ?? 0); i++) {
    await page.mouse.move(720, 450);
    await page.mouse.wheel(0, 650);
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `${slug}--${i + 2}.png`) });
    console.log(`ok  ${slug}--${i + 2}  (scrolled)`);
  }
}

function pngSize(file) {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: "light",
  deviceScaleFactor: 1,
});
const page = await context.newPage();

for (const [slug, route, opts] of PUBLIC_SHOTS) await shoot(page, slug, route, opts);

console.log("signing in…");
await page.goto(`${BASE}/en/sign-in`, { waitUntil: "domcontentloaded" });
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL("**/app/**", { timeout: 30_000 });
console.log("signed in:", page.url());

for (const [slug, route, opts] of APP_SHOTS) await shoot(page, slug, route, opts);

await browser.close();

let bad = 0;
for (const f of fs.readdirSync(OUT).filter((f) => f.endsWith(".png"))) {
  const { w, h } = pngSize(path.join(OUT, f));
  if (w !== 1440 || h !== 900) {
    console.error(`WRONG SIZE ${f}: ${w}x${h}`);
    bad++;
  }
}
console.log(bad === 0 ? "all screenshots are 1440x900" : `${bad} screenshots have wrong size`);
