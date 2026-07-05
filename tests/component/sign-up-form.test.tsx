// @vitest-environment jsdom
import type * as NextNavigation from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { SignUpForm } from "@/components/auth/sign-up-form";
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
    renderWithIntl(<SignUpForm locale="en" returnTo="/en/app/dashboard" />);
    expect(screen.getByRole("heading", { name: /create your account/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
  });

  it("links back to sign-in", () => {
    renderWithIntl(<SignUpForm locale="fr" returnTo="/fr/app/dashboard" />);
    expect(screen.getByRole("link", { name: /already have an account/i })).toHaveAttribute(
      "href",
      "/fr/sign-in",
    );
  });

  it("hides social login on an invited sign-up (OAuth would drop the token)", () => {
    renderWithIntl(
      <SignUpForm
        locale="en"
        returnTo="/en/app/dashboard"
        invitation={{ token: "tok-123", email: "ada@acme.com", organizationName: "Acme" }}
      />,
    );
    // The invite banner + email/password form are shown...
    expect(screen.getByText(/joining Acme/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toHaveValue("ada@acme.com");
    // ...but the social buttons (which don't carry the invitation) are gone.
    expect(screen.queryByRole("button", { name: /continue with google/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /continue with microsoft/i }),
    ).not.toBeInTheDocument();
    // The "have an account? sign in" link stays — an existing user can sign in.
    expect(screen.getByRole("link", { name: /already have an account/i })).toBeInTheDocument();
  });
});
