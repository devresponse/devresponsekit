import { beforeEach, describe, expect, it, vi } from "vitest";
import SignInPage from "@/app/[locale]/(auth)/sign-in/page";
import ScopedSignInPage from "@/app/[locale]/(auth)/sign-in/[org]/page";
import SignUpPage from "@/app/[locale]/(auth)/sign-up/page";

/**
 * Executes the sign-in, scoped sign-in and sign-up RSCs and asserts the
 * `returnTo` each one hands its form, which becomes Better Auth's `callbackURL`
 * (F-35).
 *
 * The language switcher keeps the query string byte-for-byte. After a switch on
 * `/en/sign-in?returnTo=%2Fen%2Fapp%2Fdashboard` (the default `returnTo` that
 * the signed-out redirect mints), the page is `/uk/sign-in` but its `returnTo`
 * still says `/en/…`. A page that honoured it verbatim sent the user back to
 * English after sign-in, undoing the language they had just picked. Before the
 * switcher kept the query, the `returnTo` was dropped and the page fell back to
 * its own locale's dashboard. So for this default path, keeping the query was a
 * regression unless the page re-points the locale. The forms and every server
 * dependency are stubbed. The sanitizer is the real one.
 */
vi.mock("@/components/auth/sign-in-form", () => ({
  SignInForm: function SignInForm() {
    return null;
  },
}));
vi.mock("@/components/auth/sign-up-form", () => ({
  SignUpForm: function SignUpForm() {
    return null;
  },
}));
vi.mock("@/components/i18n/locale-switcher", () => ({
  LocaleSwitcher: function LocaleSwitcher() {
    return null;
  },
}));
vi.mock("@/lib/auth", () => ({ enabledSocialProviders: [] }));
const resolveOrganizationByIdentifier = vi.fn();
vi.mock("@/lib/org-lookup.server", () => ({
  resolveOrganizationByIdentifier: (...a: unknown[]) => resolveOrganizationByIdentifier(...a),
}));
const findValidInvitationByToken = vi.fn();
vi.mock("@/lib/invitations.server", () => ({
  findValidInvitationByToken: (...a: unknown[]) => findValidInvitationByToken(...a),
}));

beforeEach(() => {
  resolveOrganizationByIdentifier.mockReset();
  resolveOrganizationByIdentifier.mockResolvedValue(null);
  findValidInvitationByToken.mockReset();
  findValidInvitationByToken.mockResolvedValue(null);
});

/** The props the page hands to the named form, found in the rendered tree. */
function propsOf(node: unknown, name: string): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  const el = node as { type?: { name?: string }; props?: Record<string, unknown> };
  if (el.type?.name === name) return el.props ?? null;
  const children = el.props?.children;
  for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) {
    const found = propsOf(child, name);
    if (found) return found;
  }
  return null;
}

function route(locale: string, query: Record<string, string>) {
  return { params: Promise.resolve({ locale }), searchParams: Promise.resolve(query) };
}

describe("auth pages re-point returnTo at the page's locale (F-35)", () => {
  it("sign-in: the signed-out dashboard default lands in the language picked on sign-in", async () => {
    const tree = await SignInPage(route("uk", { returnTo: "/en/app/dashboard" }));
    expect(propsOf(tree, "SignInForm")).toMatchObject({
      locale: "uk",
      returnTo: "/uk/app/dashboard",
    });
  });

  it("sign-in: a deep link keeps its path and query and changes locale only", async () => {
    const tree = await SignInPage(
      route("fr", { returnTo: "/en/app/administrator/users?page=3&filter[status]=blocked" }),
    );
    expect(propsOf(tree, "SignInForm")?.returnTo).toBe(
      "/fr/app/administrator/users?page=3&filter[status]=blocked",
    );
  });

  it("sign-in: the SSO launch continuation keeps the locale its own query forwards", async () => {
    const tree = await SignInPage(
      route("fr", { returnTo: "/en/sso/launch?applicationId=portal&locale=en" }),
    );
    expect(propsOf(tree, "SignInForm")?.returnTo).toBe(
      "/fr/sso/launch?applicationId=portal&locale=en",
    );
  });

  it("sign-in: still sanitizes, so an off-site returnTo falls back to this locale's dashboard", async () => {
    const tree = await SignInPage(route("fr", { returnTo: "//evil.example.com/x" }));
    expect(propsOf(tree, "SignInForm")?.returnTo).toBe("/fr/app/dashboard");
  });

  it("scoped sign-in (/sign-in/[org]) re-points it too", async () => {
    const tree = await ScopedSignInPage({
      params: Promise.resolve({ locale: "uk", org: "acme" }),
      searchParams: Promise.resolve({ returnTo: "/en/app/workspace" }),
    });
    expect(propsOf(tree, "SignInForm")?.returnTo).toBe("/uk/app/workspace");
    expect(resolveOrganizationByIdentifier).toHaveBeenCalledWith("acme");
  });

  it("sign-up re-points it too", async () => {
    const tree = await SignUpPage(route("es", { returnTo: "/en/app/workspace" }));
    expect(propsOf(tree, "SignUpForm")).toMatchObject({
      locale: "es",
      returnTo: "/es/app/workspace",
    });
  });
});
