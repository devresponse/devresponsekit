// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { SignUpForm } from "@/components/auth/sign-up-form";
import { renderWithIntl } from "../helpers/render-with-intl";

describe("SignUpForm", () => {
  it("renders the sign-up card with name/email/password and social buttons", () => {
    renderWithIntl(<SignUpForm locale="en" returnTo="/en/app/dashboard" />);
    expect(screen.getByRole("heading", { name: /create your account/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument();
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
});
