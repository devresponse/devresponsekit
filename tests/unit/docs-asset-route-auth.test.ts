import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { __resetRateLimitForTests } from "@/lib/http/rate-limit.server";
import { serveSpaceAsset } from "@/lib/docs/asset-route.server";
import type * as SafePathModule from "@/lib/docs/safe-path.server";
import { GET as getDocsAsset } from "@/app/api/docs/asset/[...path]/route";
import { GET as getHelpAsset } from "@/app/api/help/asset/[...path]/route";

/**
 * F-92: the docs and help image routes answer only the viewers' audience, an
 * active user with an active membership holding `shell.view`, and say nothing
 * to anyone else: every refusal is a bodiless 404, decided before the path is
 * resolved, so it cannot reveal whether a file exists. Nothing tested this, so
 * a refactor that dropped any one gate would have served images to that
 * caller with every check green. The route files are called too, so a route
 * that stops delegating (or names the wrong space) fails here.
 */
const state = vi.hoisted(() => ({
  session: null as unknown,
  access: {
    status: "active",
    membershipStatus: "active" as string | null,
    permissions: ["shell.view"],
  },
}));
vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: async () => state.session }));
vi.mock("@/lib/session-access.server", () => ({
  getSessionAccessContext: async () => state.access,
}));
const resolveSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/docs/safe-path.server", async (importOriginal) => {
  const actual = await importOriginal<typeof SafePathModule>();
  resolveSpy.mockImplementation(actual.resolveAssetFile);
  return { ...actual, resolveAssetFile: resolveSpy };
});

const SCREENSHOT = ["screenshots", "01-landing.png"];
const SCREENSHOT_FILE = path.resolve(__dirname, "../../help/screenshots/01-landing.png");
const request = () => ({ headers: new Headers() });
const serve = () => serveSpaceAsset("help", SCREENSHOT, request());

async function expectRefused(response: Response): Promise<void> {
  expect(response.status).toBe(404);
  expect(await response.text()).toBe("");
  expect(resolveSpy).not.toHaveBeenCalled();
}

beforeEach(() => {
  __resetRateLimitForTests();
  resolveSpy.mockClear();
  state.session = { user: { id: "user-1" }, session: {} };
  state.access = { status: "active", membershipStatus: "active", permissions: ["shell.view"] };
});

describe("serveSpaceAsset authorization (F-92)", () => {
  it("serves a member the image with the hardened headers", async () => {
    const response = await serve();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(readFileSync(SCREENSHOT_FILE));
  });

  it("refuses a caller with no session", async () => {
    state.session = null;
    await expectRefused(await serve());
  });

  it.each(["blocked", "suspended", "deactivated", "pending_approval"])(
    "refuses a user whose status is %s",
    async (status) => {
      state.access = { ...state.access, status };
      await expectRefused(await serve());
    },
  );

  it.each([null, "pending_approval", "blocked", "suspended"])(
    "refuses a user whose membership is %s",
    async (membershipStatus) => {
      state.access = { ...state.access, membershipStatus };
      await expectRefused(await serve());
    },
  );

  it("refuses an active member without shell.view", async () => {
    state.access = { ...state.access, permissions: ["admin.audit.read"] };
    await expectRefused(await serve());
  });
});

describe("the asset routes delegate to serveSpaceAsset with their own space (F-92)", () => {
  const params = (p: string[]) => ({ params: Promise.resolve({ path: p }) });
  const req = () => request() as unknown as NextRequest;

  it("serves a help image only through the help route", async () => {
    expect((await getHelpAsset(req(), params(SCREENSHOT))).status).toBe(200);
    expect((await getDocsAsset(req(), params(SCREENSHOT))).status).toBe(404);
  });

  it("applies the gate on both routes", async () => {
    state.session = null;
    await expectRefused(await getHelpAsset(req(), params(SCREENSHOT)));
    await expectRefused(await getDocsAsset(req(), params(SCREENSHOT)));
  });
});
