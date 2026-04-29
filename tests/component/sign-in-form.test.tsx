// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { SignInForm } from "@/components/auth/sign-in-form";
import { renderWithIntl } from "../helpers/render-with-intl";

describe("SignInForm", () => {
  it("renders a heading, email/password fields, and all three social buttons (§14.1)", () => {
    renderWithIntl(<SignInForm locale="en" returnTo="/en/app/dashboard" />);
    expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with microsoft/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with github/i })).toBeInTheDocument();
  });

  it("offers a forgot-password and a create-account link", () => {
    renderWithIntl(<SignInForm locale="en" returnTo="/en/app/dashboard" />);
    expect(screen.getByRole("link", { name: /forgot password/i })).toHaveAttribute(
      "href",
      "/en/forgot-password",
    );
    expect(screen.getByRole("link", { name: /create account/i })).toHaveAttribute(
      "href",
      "/en/sign-up",
    );
  });
});
