// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EmailPasswordSignUpForm } from "@/components/auth/email-password-sign-up-form";
import { renderWithIntl } from "../helpers/render-with-intl";

const signUpEmail = vi.fn();
const signInEmail = vi.fn();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signUp: { email: (...args: unknown[]) => signUpEmail(...args) },
    signIn: { email: (...args: unknown[]) => signInEmail(...args) },
  },
}));

beforeEach(() => {
  signUpEmail.mockReset();
  signInEmail.mockReset();
  replace.mockReset();
});

afterEach(() => {
  signUpEmail.mockReset();
  signInEmail.mockReset();
  replace.mockReset();
});

describe("EmailPasswordSignUpForm", () => {
  it("renders required fields with the expected autocomplete hints", () => {
    renderWithIntl(
      <EmailPasswordSignUpForm verifyEmailHref="/en/verify-email" postVerifyHref="/en/app" />,
    );
    expect(screen.getByLabelText(/^name/i)).toHaveAttribute("autocomplete", "name");
    expect(screen.getByLabelText(/email/i)).toHaveAttribute("autocomplete", "email");
    expect(screen.getByLabelText(/password/i)).toHaveAttribute("autocomplete", "new-password");
  });

  it("submits credentials with the supplied callback URL", async () => {
    signUpEmail.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();
    renderWithIntl(
      <EmailPasswordSignUpForm verifyEmailHref="/en/verify-email" postVerifyHref="/en/app" />,
    );

    await user.type(screen.getByLabelText(/^name/i), "Ada Lovelace");
    await user.type(screen.getByLabelText(/email/i), "ada@example.com");
    await user.type(screen.getByLabelText(/password/i), "Password!1234");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(signUpEmail).toHaveBeenCalledWith({
      email: "ada@example.com",
      password: "Password!1234",
      name: "Ada Lovelace",
      callbackURL: "/en/app",
    });
    expect(replace).toHaveBeenCalledWith("/en/verify-email");
  });

  it("signs in immediately when the org policy waived verification (pre-verified account)", async () => {
    signUpEmail.mockResolvedValueOnce({ error: null, data: { user: { emailVerified: true } } });
    signInEmail.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();
    renderWithIntl(
      <EmailPasswordSignUpForm verifyEmailHref="/en/verify-email" postVerifyHref="/en/app" />,
    );

    await user.type(screen.getByLabelText(/^name/i), "Ada Lovelace");
    await user.type(screen.getByLabelText(/email/i), "ada@acme.com");
    await user.type(screen.getByLabelText(/password/i), "Password!1234");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(signInEmail).toHaveBeenCalledWith({
      email: "ada@acme.com",
      password: "Password!1234",
      callbackURL: "/en/app",
    });
    // Better Auth's callbackURL handling performs the navigation — the form
    // must NOT bounce a pre-verified user to the verify-email page.
    expect(replace).not.toHaveBeenCalled();
  });

  it("shows the error alert when the immediate sign-in unexpectedly fails", async () => {
    signUpEmail.mockResolvedValueOnce({ error: null, data: { user: { emailVerified: true } } });
    signInEmail.mockResolvedValueOnce({ error: { code: "UNEXPECTED" } });
    const user = userEvent.setup();
    renderWithIntl(
      <EmailPasswordSignUpForm verifyEmailHref="/en/verify-email" postVerifyHref="/en/app" />,
    );

    await user.type(screen.getByLabelText(/^name/i), "Ada Lovelace");
    await user.type(screen.getByLabelText(/email/i), "ada@acme.com");
    await user.type(screen.getByLabelText(/password/i), "Password!1234");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("locks the invited email and threads the invitation token through the sign-up body", async () => {
    signUpEmail.mockResolvedValueOnce({ error: null, data: { user: { emailVerified: true } } });
    signInEmail.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();
    renderWithIntl(
      <EmailPasswordSignUpForm
        verifyEmailHref="/en/verify-email"
        postVerifyHref="/en/app"
        invitationToken="tok-123"
        invitedEmail="ada@acme.com"
      />,
    );

    const email = screen.getByLabelText(/email/i);
    expect(email).toHaveValue("ada@acme.com");
    expect(email).toBeDisabled();

    await user.type(screen.getByLabelText(/^name/i), "Ada Lovelace");
    await user.type(screen.getByLabelText(/password/i), "Password!1234");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(signUpEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "ada@acme.com", invitationToken: "tok-123" }),
    );
    // Invited sign-ups arrive pre-verified → immediate sign-in, no
    // verify-email bounce.
    expect(signInEmail).toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("renders the unexpectedError alert when sign-up fails", async () => {
    signUpEmail.mockResolvedValueOnce({ error: { code: "USER_ALREADY_EXISTS" } });
    const user = userEvent.setup();
    renderWithIntl(
      <EmailPasswordSignUpForm verifyEmailHref="/en/verify-email" postVerifyHref="/en/app" />,
    );

    await user.type(screen.getByLabelText(/^name/i), "x");
    await user.type(screen.getByLabelText(/email/i), "x@example.com");
    await user.type(screen.getByLabelText(/password/i), "Password!1234");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
