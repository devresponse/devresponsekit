// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SocialLoginButtons } from "@/components/auth/social-login-buttons";
import { renderWithIntl } from "../helpers/render-with-intl";

const signInSocial = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: {
      social: (...args: unknown[]) => signInSocial(...args),
    },
  },
}));

beforeEach(() => signInSocial.mockReset());
afterEach(() => signInSocial.mockReset());

describe("SocialLoginButtons", () => {
  it("renders all three providers with translated labels", () => {
    renderWithIntl(<SocialLoginButtons returnTo="/en/app/dashboard" />);
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with microsoft/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with github/i })).toBeInTheDocument();
  });

  it("forwards the sanitized callback URL to authClient.signIn.social", async () => {
    signInSocial.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderWithIntl(<SocialLoginButtons returnTo="/en/app/workspace" />);

    await user.click(screen.getByRole("button", { name: /continue with google/i }));
    expect(signInSocial).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: "/en/app/workspace",
    });

    await user.click(screen.getByRole("button", { name: /continue with microsoft/i }));
    expect(signInSocial).toHaveBeenLastCalledWith({
      provider: "microsoft",
      callbackURL: "/en/app/workspace",
    });

    await user.click(screen.getByRole("button", { name: /continue with github/i }));
    expect(signInSocial).toHaveBeenLastCalledWith({
      provider: "github",
      callbackURL: "/en/app/workspace",
    });
  });
});
