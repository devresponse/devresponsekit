import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redirect } from "next/navigation";
import en from "@/messages/en.json";
import uk from "@/messages/uk.json";

/**
 * F-37: how the signed-in viewer's display preferences reach every render.
 *
 * `getViewerFormatPreferences` runs for EVERY page, public ones included (it
 * feeds next-intl's request config and the root layout), so the cost and
 * failure rules are pinned here, not just the mapping:
 *   - signed out: no session read and no query, the deployment defaults;
 *   - signed in: one query keyed by the session's own user;
 *   - any failure: the defaults and a log line, never a failed page;
 *   - Next's control-flow errors still propagate.
 * The request config (`src/i18n/request.ts`) is then pinned to hand the
 * resolved zone to next-intl, which passes it on to the client provider.
 */

const requestHeaders = { current: new Headers() as Headers | Error };
vi.mock("next/headers", () => ({
  headers: async () => {
    if (requestHeaders.current instanceof Error) throw requestHeaders.current;
    return requestHeaders.current;
  },
}));

const getCurrentSession = vi.fn();
vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => getCurrentSession() }));

const logServerError = vi.fn();
vi.mock("@/lib/observability/logger.server", () => ({
  logServerError: (...args: unknown[]) => logServerError(...args),
}));

// Records the lookup's WHERE and answers with `row`.
const lookup = {
  row: undefined as Record<string, string | null> | undefined,
  error: null as Error | null,
  where: [] as unknown[][],
  calls: 0,
};
vi.mock("@/db/database", () => {
  const chain: Record<string, unknown> = {
    leftJoin: () => chain,
    select: () => chain,
    where: (...args: unknown[]) => {
      lookup.where.push(args);
      return chain;
    },
    executeTakeFirst: async () => {
      lookup.calls += 1;
      if (lookup.error) throw lookup.error;
      return lookup.row;
    },
  };
  return { db: { selectFrom: () => chain } };
});

// `getRequestConfig` is the identity so the config function can be called
// directly (the real one only runs inside a React Server Components render).
vi.mock("next-intl/server", () => ({
  getRequestConfig: (fn: unknown) => fn,
}));

const SESSION_COOKIE = "better-auth.session_token=abc.def";
const SESSION = { user: { id: "ba-user-1" }, session: { token: "abc" } };

function signedIn() {
  requestHeaders.current = new Headers({ cookie: SESSION_COOKIE });
  getCurrentSession.mockResolvedValue(SESSION);
}

async function load() {
  return import("@/lib/format/viewer-format.server");
}

beforeEach(() => {
  requestHeaders.current = new Headers();
  getCurrentSession.mockReset();
  logServerError.mockReset();
  lookup.row = undefined;
  lookup.error = null;
  lookup.where = [];
  lookup.calls = 0;
});
afterEach(() => vi.resetModules());

describe("getViewerFormatPreferences (F-37)", () => {
  it("signed out: the deployment defaults, with no session read and no query", async () => {
    const { getViewerFormatPreferences, deploymentTimeZone } = await load();
    await expect(getViewerFormatPreferences()).resolves.toEqual({
      timeZone: deploymentTimeZone(),
      dateFormat: "system",
      numberLocale: null,
    });
    expect(getCurrentSession).not.toHaveBeenCalled();
    expect(lookup.calls).toBe(0);
  });

  it("the deployment zone is the runtime's own", async () => {
    const { deploymentTimeZone } = await load();
    expect(deploymentTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("signed in: the viewer's saved preferences, looked up by the session's own user", async () => {
    signedIn();
    lookup.row = { time_zone: "Europe/Kyiv", date_format: "iso8601", number_format_locale: "fr" };
    const { getViewerFormatPreferences } = await load();
    await expect(getViewerFormatPreferences()).resolves.toEqual({
      timeZone: "Europe/Kyiv",
      dateFormat: "iso8601",
      numberLocale: "fr",
    });
    expect(lookup.calls).toBe(1);
    expect(lookup.where).toEqual([["u.better_auth_user_id", "=", "ba-user-1"]]);
  });

  it("a cookie with no live session (expired, revoked) gets the defaults without a query", async () => {
    requestHeaders.current = new Headers({ cookie: SESSION_COOKIE });
    getCurrentSession.mockResolvedValue(null);
    const { getViewerFormatPreferences, deploymentTimeZone } = await load();
    await expect(getViewerFormatPreferences()).resolves.toMatchObject({
      timeZone: deploymentTimeZone(),
      dateFormat: "system",
    });
    expect(lookup.calls).toBe(0);
  });

  it("no preferences row, or a zone this runtime does not know, falls back per field", async () => {
    signedIn();
    const { getViewerFormatPreferences, deploymentTimeZone } = await load();
    await expect(getViewerFormatPreferences()).resolves.toEqual({
      timeZone: deploymentTimeZone(),
      dateFormat: "system",
      numberLocale: null,
    });

    vi.resetModules();
    lookup.row = { time_zone: "Mars/Olympus_Mons", date_format: "us", number_format_locale: null };
    const again = await load();
    await expect(again.getViewerFormatPreferences()).resolves.toEqual({
      timeZone: again.deploymentTimeZone(),
      dateFormat: "us",
      numberLocale: null,
    });
  });

  it("a failed lookup renders the page with the defaults and logs it", async () => {
    signedIn();
    lookup.error = new Error("connect ECONNREFUSED");
    const { getViewerFormatPreferences } = await load();
    await expect(getViewerFormatPreferences()).resolves.toMatchObject({ dateFormat: "system" });
    expect(logServerError).toHaveBeenCalledTimes(1);

    vi.resetModules();
    logServerError.mockReset();
    getCurrentSession.mockRejectedValue(new Error("session store down"));
    const again = await load();
    await expect(again.getViewerFormatPreferences()).resolves.toMatchObject({
      dateFormat: "system",
    });
    expect(logServerError).toHaveBeenCalledTimes(1);
  });

  it("outside a request (no headers) it answers the defaults instead of throwing", async () => {
    requestHeaders.current = new Error("`headers` was called outside a request scope.");
    const { getViewerFormatPreferences } = await load();
    await expect(getViewerFormatPreferences()).resolves.toMatchObject({ dateFormat: "system" });
  });

  it("re-throws Next's own control-flow errors untouched", async () => {
    requestHeaders.current = new Headers({ cookie: SESSION_COOKIE });
    let thrown: unknown;
    try {
      redirect("/en/sign-in");
    } catch (error) {
      thrown = error;
    }
    getCurrentSession.mockRejectedValue(thrown);
    const { getViewerFormatPreferences } = await load();
    await expect(getViewerFormatPreferences()).rejects.toBe(thrown);
    expect(logServerError).not.toHaveBeenCalled();
  });

  it("getAppFormatter formats with the viewer's preferences", async () => {
    signedIn();
    lookup.row = {
      time_zone: "Asia/Kathmandu",
      date_format: "iso8601",
      number_format_locale: "fr",
    };
    const { getAppFormatter } = await load();
    const format = await getAppFormatter("en");
    expect(format.dateTime("2026-06-13T22:04:05Z")).toBe("2026-06-14 03:49");
    expect(format.number(12345.5)).toBe(new Intl.NumberFormat("fr").format(12345.5));
  });
});

describe("next-intl request config (src/i18n/request.ts)", () => {
  type Config = (params: {
    requestLocale: Promise<string | undefined>;
  }) => Promise<{ locale: string; messages: unknown; timeZone?: string }>;

  async function config(): Promise<Config> {
    return (await import("@/i18n/request")).default as unknown as Config;
  }

  it("hands next-intl the viewer's saved zone", async () => {
    signedIn();
    lookup.row = { time_zone: "Europe/Kyiv", date_format: null, number_format_locale: null };
    const result = await (await config())({ requestLocale: Promise.resolve("uk") });
    expect(result.locale).toBe("uk");
    expect(result.timeZone).toBe("Europe/Kyiv");
    expect(result.messages).toEqual(uk);
  });

  it("signed out: the deployment zone, so server and client still agree", async () => {
    const { deploymentTimeZone } = await load();
    const result = await (await config())({ requestLocale: Promise.resolve("xx") });
    expect(result.locale).toBe("en");
    expect(result.messages).toEqual(en);
    expect(result.timeZone).toBe(deploymentTimeZone());
    expect(lookup.calls).toBe(0);
  });
});
