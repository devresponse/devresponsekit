// @vitest-environment jsdom
import type * as NextNavigation from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { SignUpForm } from "@/components/auth/sign-up-form";
import { SOCIAL_PROVIDERS } from "@/lib/social-providers";
import { renderWithIntl } from "../helpers/render-with-intl";

const replace = vi.fn();

vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof NextNavigation>();
  return {
    ...actual,
    useRouter: () => ({ replace }),
  };
});

describe("SignUpForm", () => {
  beforeEach(() => {
    replace.mockReset();
  });

  it("renders the sign-up card with name/email/password and social buttons", () => {
    renderWithIntl(
      <SignUpForm locale="en" returnTo="/en/app/dashboard" socialProviders={SOCIAL_PROVIDERS} />,
    );
    expect(screen.getByRole("heading", { name: /create your account/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
  });

  it("links back to sign-in", () => {
    renderWithIntl(
      <SignUpForm locale="fr" returnTo="/fr/app/dashboard" socialProviders={SOCIAL_PROVIDERS} />,
    );
    expect(screen.getByRole("link", { name: /already have an account/i })).toHaveAttribute(
      "href",
      "/fr/sign-in",
    );
  });

  it("drops the social section when no provider is configured", () => {
    renderWithIntl(<SignUpForm locale="en" returnTo="/en/app/dashboard" socialProviders={[]} />);
    expect(screen.getByLabelText(/^name/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /continue with/i })).toBeNull();
  });

  it("hides social login on an invited sign-up (OAuth would drop the token)", () => {
    renderWithIntl(
      <SignUpForm
        locale="en"
        returnTo="/en/app/dashboard"
        socialProviders={SOCIAL_PROVIDERS}
        invitation={{ token: "tok-123", email: "ada@acme.com", organizationName: "Acme" }}
      />,
    );
    // The invite banner + email/password form are shown...
    expect(screen.getByText(/joining Acme/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toHaveValue("ada@acme.com");
    // ...but the social buttons (which don't carry the invitation) are gone
    // even though every provider is configured.
    expect(screen.queryByRole("button", { name: /continue with google/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /continue with microsoft/i }),
    ).not.toBeInTheDocument();
    // The "have an account? sign in" link stays — an existing user can sign in.
    expect(screen.getByRole("link", { name: /already have an account/i })).toBeInTheDocument();
  });

  it("brands the screen and scopes the sign-in link for an organization-scoped sign-up", () => {
    renderWithIntl(
      <SignUpForm
        locale="en"
        returnTo="/en/app/dashboard"
        socialProviders={SOCIAL_PROVIDERS}
        organization={{ id: "o-1", slug: "acme", name: "Acme" }}
      />,
    );
    expect(screen.getByText(/create your account for acme/i)).toBeInTheDocument();
    const signInLink = screen.getByRole("link", { name: /already have an account/i });
    expect(signInLink.getAttribute("href")).toContain("org=acme");
  });

  it("ignores org scoping when an invitation is present (the invitation's org wins)", () => {
    renderWithIntl(
      <SignUpForm
        locale="en"
        returnTo="/en/app/dashboard"
        socialProviders={SOCIAL_PROVIDERS}
        organization={{ id: "o-1", slug: "acme", name: "Acme" }}
        invitation={{ token: "t", email: "ada@acme.com", organizationName: "Acme Invited" }}
      />,
    );
    expect(screen.getByText(/joining Acme Invited/i)).toBeInTheDocument();
    expect(screen.queryByText(/create your account for acme/i)).toBeNull();
  });
});
