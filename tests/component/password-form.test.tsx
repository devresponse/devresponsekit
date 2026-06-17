// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PasswordForm } from "@/app/[locale]/(secure)/app/account/security/_password-form";
import { renderWithIntl } from "../helpers/render-with-intl";

vi.mock("@/lib/auth-client", () => ({ authClient: { changePassword: vi.fn() } }));
import { authClient } from "@/lib/auth-client";
const changePassword = authClient.changePassword as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => changePassword.mockReset());
afterEach(() => vi.clearAllMocks());

describe("PasswordForm", () => {
  it("marks all three password fields required", () => {
    renderWithIntl(<PasswordForm />);
    expect(screen.getByLabelText(/current password/i)).toHaveAttribute("aria-required", "true");
    expect(screen.getByLabelText(/^New password/)).toHaveAttribute("aria-required", "true");
    expect(screen.getByLabelText(/confirm new password/i)).toHaveAttribute("aria-required", "true");
  });

  it("shows a mismatch error on the confirm field and does not call Better Auth", async () => {
    const user = userEvent.setup();
    renderWithIntl(<PasswordForm />);
    await user.type(screen.getByLabelText(/current password/i), "oldpass");
    await user.type(screen.getByLabelText(/^New password/), "password123");
    await user.type(screen.getByLabelText(/confirm new password/i), "different1");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    expect(await screen.findByText("Passwords do not match.")).toBeInTheDocument();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("calls Better Auth and shows confirmation on success", async () => {
    const user = userEvent.setup();
    changePassword.mockResolvedValue({ data: {}, error: null });
    renderWithIntl(<PasswordForm />);
    await user.type(screen.getByLabelText(/current password/i), "oldpass");
    await user.type(screen.getByLabelText(/^New password/), "password123");
    await user.type(screen.getByLabelText(/confirm new password/i), "password123");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() =>
      expect(changePassword).toHaveBeenCalledWith(
        expect.objectContaining({
          currentPassword: "oldpass",
          newPassword: "password123",
          revokeOtherSessions: true,
        }),
      ),
    );
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });
});
