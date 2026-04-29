// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EmailPasswordLoginForm } from "@/components/auth/email-password-login-form";
import { renderWithIntl } from "../helpers/render-with-intl";

const signInEmail = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: {
      email: (...args: unknown[]) => signInEmail(...args),
    },
  },
}));

beforeEach(() => signInEmail.mockReset());
afterEach(() => signInEmail.mockReset());

describe("EmailPasswordLoginForm", () => {
  it("renders required fields and a loading-aware submit button", () => {
    renderWithIntl(<EmailPasswordLoginForm returnTo="/en/app/dashboard" />);
    expect(screen.getByLabelText(/email/i)).toBeRequired();
    expect(screen.getByLabelText(/password/i)).toBeRequired();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeEnabled();
  });

  it("submits credentials with the sanitized returnTo as the callback URL", async () => {
    signInEmail.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();
    renderWithIntl(<EmailPasswordLoginForm returnTo="/en/app/workspace" />);

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.type(screen.getByLabelText(/password/i), "Hunter2!Strong");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(signInEmail).toHaveBeenCalledTimes(1));
    expect(signInEmail).toHaveBeenCalledWith({
      email: "user@example.com",
      password: "Hunter2!Strong",
      callbackURL: "/en/app/workspace",
    });
  });

  it("renders the translated invalidCredentials message on auth error", async () => {
    signInEmail.mockResolvedValueOnce({ error: { code: "INVALID_CREDENTIALS" } });
    const user = userEvent.setup();
    renderWithIntl(<EmailPasswordLoginForm returnTo="/en/app/dashboard" />);

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.type(screen.getByLabelText(/password/i), "wrong");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid email or password/i);
  });

  it("falls back to a generic message on unexpected errors", async () => {
    signInEmail.mockRejectedValueOnce(new Error("boom"));
    const user = userEvent.setup();
    renderWithIntl(<EmailPasswordLoginForm returnTo="/en/app/dashboard" />);

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.type(screen.getByLabelText(/password/i), "x");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/unexpected/i);
  });
});
