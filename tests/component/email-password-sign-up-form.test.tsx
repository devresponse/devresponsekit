// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EmailPasswordSignUpForm } from "@/components/auth/email-password-sign-up-form";
import { renderWithIntl } from "../helpers/render-with-intl";

const signUpEmail = vi.fn();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signUp: { email: (...args: unknown[]) => signUpEmail(...args) },
  },
}));

beforeEach(() => {
  signUpEmail.mockReset();
  replace.mockReset();
});

afterEach(() => {
  signUpEmail.mockReset();
  replace.mockReset();
});

describe("EmailPasswordSignUpForm", () => {
  it("renders required fields with the expected autocomplete hints", () => {
    renderWithIntl(<EmailPasswordSignUpForm pendingApprovalHref="/en/pending-approval" />);
    expect(screen.getByLabelText(/^name$/i)).toHaveAttribute("autocomplete", "name");
    expect(screen.getByLabelText(/email/i)).toHaveAttribute("autocomplete", "email");
    expect(screen.getByLabelText(/password/i)).toHaveAttribute("autocomplete", "new-password");
  });

  it("submits credentials with the supplied callback URL", async () => {
    signUpEmail.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();
    renderWithIntl(<EmailPasswordSignUpForm pendingApprovalHref="/en/pending-approval" />);

    await user.type(screen.getByLabelText(/^name$/i), "Ada Lovelace");
    await user.type(screen.getByLabelText(/email/i), "ada@example.com");
    await user.type(screen.getByLabelText(/password/i), "Password!1234");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(signUpEmail).toHaveBeenCalledWith({
      email: "ada@example.com",
      password: "Password!1234",
      name: "Ada Lovelace",
      callbackURL: "/en/pending-approval",
    });
    expect(replace).toHaveBeenCalledWith("/en/pending-approval");
  });

  it("renders the unexpectedError alert when sign-up fails", async () => {
    signUpEmail.mockResolvedValueOnce({ error: { code: "USER_ALREADY_EXISTS" } });
    const user = userEvent.setup();
    renderWithIntl(<EmailPasswordSignUpForm pendingApprovalHref="/en/pending-approval" />);

    await user.type(screen.getByLabelText(/^name$/i), "x");
    await user.type(screen.getByLabelText(/email/i), "x@example.com");
    await user.type(screen.getByLabelText(/password/i), "Password!1234");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
