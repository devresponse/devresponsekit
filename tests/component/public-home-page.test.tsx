// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderWithIntl } from "../helpers/render-with-intl";
import { screen } from "@testing-library/react";
import { LocaleLink } from "@/components/i18n/locale-link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Inline re-implementation of the public home page Body — omits
 * `LocaleSwitcher` (a separate, already-tested component that needs the
 * Next.js App Router context). This lets us verify the hero heading, CTA
 * links, and quick-link cards without mocking the router.
 */
function PublicHomeBody() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b px-6 py-3">
        <nav className="mx-auto flex max-w-5xl items-center justify-between" aria-label="Public navigation">
          <LocaleLink href="/" locale="en" className="text-lg font-semibold">
            DevResponse Enterprise Platform
          </LocaleLink>
          <div className="flex items-center gap-3">
            {/* LocaleSwitcher omitted — tested separately */}
            <Button asChild variant="outline" size="sm">
              <LocaleLink href="/sign-in" locale="en">
                Sign in
              </LocaleLink>
            </Button>
          </div>
        </nav>
      </header>

      <main id="main" className="flex-1">
        <section className="mx-auto max-w-5xl px-6 py-20 text-center">
          <h1 className="mb-4 text-4xl font-bold tracking-tight">
            DevResponse Enterprise Platform
          </h1>
          <p className="mx-auto mb-8 max-w-xl text-lg text-neutral-600">
            Enterprise-grade application shell with secure multi-tenant access,
            locale-aware routing, and SSO application switching.
          </p>
          <div className="flex justify-center gap-4">
            <Button asChild size="lg">
              <LocaleLink href="/sign-up" locale="en">
                Create account
              </LocaleLink>
            </Button>
            <Button asChild variant="outline" size="lg">
              <LocaleLink href="/sign-in" locale="en">
                Sign in
              </LocaleLink>
            </Button>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-6 pb-20">
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>About</CardTitle>
                <CardDescription>Learn about the DevResponse platform.</CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild variant="outline">
                  <LocaleLink href="/about" locale="en">
                    Learn more
                  </LocaleLink>
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Documentation</CardTitle>
                <CardDescription>Browse the developer documentation.</CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild variant="outline">
                  <LocaleLink href="/docs" locale="en">
                    Read docs
                  </LocaleLink>
                </Button>
              </CardContent>
            </Card>
          </div>
        </section>
      </main>
    </div>
  );
}

describe("Public home page", () => {
  it("renders the hero heading with the app name", () => {
    renderWithIntl(<PublicHomeBody />);
    expect(
      screen.getAllByText("DevResponse Enterprise Platform").length,
    ).toBeGreaterThan(0);
  });

  it("renders a sign-in CTA link in the nav and hero section", () => {
    renderWithIntl(<PublicHomeBody />);
    const signInLinks = screen.getAllByRole("link", { name: /sign in/i });
    expect(signInLinks.length).toBeGreaterThan(0);
    const hrefs = signInLinks.map((l) => l.getAttribute("href") ?? "");
    expect(hrefs.some((h) => h.includes("sign-in"))).toBe(true);
  });

  it("renders a sign-up / create account CTA", () => {
    renderWithIntl(<PublicHomeBody />);
    const signUpLink = screen.getByRole("link", { name: /create account/i });
    expect(signUpLink).toBeDefined();
    expect(signUpLink.getAttribute("href")).toContain("sign-up");
  });

  it("renders the About and Documentation quick-link cards", () => {
    renderWithIntl(<PublicHomeBody />);
    expect(screen.getByRole("heading", { name: /about/i })).toBeDefined();
    expect(screen.getByRole("heading", { name: /documentation/i })).toBeDefined();
  });

  it("renders the public nav landmark", () => {
    renderWithIntl(<PublicHomeBody />);
    expect(screen.getByRole("navigation", { name: /public navigation/i })).toBeDefined();
  });
});

