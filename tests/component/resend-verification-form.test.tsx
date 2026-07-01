// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResendVerificationForm } from "@/components/auth/resend-verification-form";
import { renderWithIntl } from "../helpers/render-with-intl";

const sendVerificationEmail = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    sendVerificationEmail: (...args: unknown[]) => sendVerificationEmail(...args),
  },
}));

beforeEach(() => sendVerificationEmail.mockReset());
afterEach(() => sendVerificationEmail.mockReset());

describe("ResendVerificationForm", () => {
  it("sends a verification email with the callback URL and shows a neutral confirmation", async () => {
    sendVerificationEmail.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();
    renderWithIntl(<ResendVerificationForm callbackUrl="/en/app" defaultEmail="ada@example.com" />);

    // Pre-filled from the prop (e.g. carried over from the sign-in form).
    expect(screen.getByLabelText(/email/i)).toHaveValue("ada@example.com");
    await user.click(screen.getByRole("button", { name: /resend verification email/i }));

    await waitFor(() => expect(sendVerificationEmail).toHaveBeenCalledTimes(1));
    expect(sendVerificationEmail).toHaveBeenCalledWith({
      email: "ada@example.com",
      callbackURL: "/en/app",
    });
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });

  it("shows the same neutral confirmation when Better Auth returns an error (anti-enumeration)", async () => {
    // Already-verified / unknown address returns { error } — the UI must NOT
    // leak that; it still shows the neutral "sent" confirmation.
    sendVerificationEmail.mockResolvedValueOnce({ error: { code: "USER_ALREADY_VERIFIED" } });
    const user = userEvent.setup();
    renderWithIntl(
      <ResendVerificationForm callbackUrl="/en/app" defaultEmail="known@example.com" />,
    );

    await user.click(screen.getByRole("button", { name: /resend verification email/i }));

    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("surfaces the generic error message only when the request throws (network)", async () => {
    sendVerificationEmail.mockRejectedValueOnce(new Error("network"));
    const user = userEvent.setup();
    renderWithIntl(<ResendVerificationForm callbackUrl="/en/app" defaultEmail="ada@example.com" />);

    await user.click(screen.getByRole("button", { name: /resend verification email/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/unexpected/i);
  });
});
