// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { SignInForm } from "@/components/auth/sign-in-form";
import { SOCIAL_PROVIDERS } from "@/lib/social-providers";
import { renderWithIntl } from "../helpers/render-with-intl";

describe("SignInForm", () => {
  it("renders a heading, email/password fields, and a button per configured provider (§14.1)", () => {
    renderWithIntl(
      <SignInForm locale="en" returnTo="/en/app/dashboard" socialProviders={SOCIAL_PROVIDERS} />,
    );
    expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with microsoft/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with github/i })).toBeInTheDocument();
  });

  it("shows only the configured providers", () => {
    renderWithIntl(
      <SignInForm locale="en" returnTo="/en/app/dashboard" socialProviders={["github"]} />,
    );
    expect(screen.getByRole("button", { name: /continue with github/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /continue with google/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /continue with microsoft/i })).toBeNull();
  });

  it("drops the social section (and the OR divider) when no provider is configured", () => {
    renderWithIntl(<SignInForm locale="en" returnTo="/en/app/dashboard" socialProviders={[]} />);
    // Email/password still renders; the social buttons and the "or" divider do not.
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /continue with/i })).toBeNull();
    expect(screen.queryByText(/^or$/i)).toBeNull();
  });

  it("offers a forgot-password and a create-account link", () => {
    renderWithIntl(
      <SignInForm locale="en" returnTo="/en/app/dashboard" socialProviders={SOCIAL_PROVIDERS} />,
    );
    expect(screen.getByRole("link", { name: /forgot password/i })).toHaveAttribute(
      "href",
      "/en/forgot-password",
    );
    expect(screen.getByRole("link", { name: /create account/i })).toHaveAttribute(
      "href",
      "/en/sign-up",
    );
  });

  it("brands the screen, keeps social buttons, and scopes the create-account link", () => {
    renderWithIntl(
      <SignInForm
        locale="en"
        returnTo="/en/app/dashboard"
        socialProviders={SOCIAL_PROVIDERS}
        organization={{ id: "o-1", slug: "acme", name: "Acme" }}
      />,
    );
    // Org branding and social sign-in coexist on the scoped screen.
    expect(screen.getByText(/sign in to acme/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with microsoft/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with github/i })).toBeInTheDocument();
    const createLink = screen.getByRole("link", { name: /create account/i });
    expect(createLink.getAttribute("href")).toContain("/sign-up");
    expect(createLink.getAttribute("href")).toContain("org=acme");
  });
});
