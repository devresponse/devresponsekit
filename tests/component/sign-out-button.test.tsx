// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { renderWithIntl } from "../helpers/render-with-intl";

const signOut = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signOut: (opts: Parameters<typeof signOut>[0]) => signOut(opts),
  },
}));

const originalLocation = globalThis.window?.location;

beforeEach(() => {
  signOut.mockReset();
});
afterEach(() => {
  // Restore window.location replacement.
  if (originalLocation) {
    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  }
});

describe("SignOutButton", () => {
  it("renders an accessible sign-out button", () => {
    renderWithIntl(<SignOutButton locale="en" />);
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
  });

  it("calls Better Auth signOut and redirects to the localized logged-out page", async () => {
    // Replace window.location.href setter to capture the navigation.
    let navigatedTo = "";
    Object.defineProperty(window, "location", {
      value: {
        ...originalLocation,
        set href(value: string) {
          navigatedTo = value;
        },
        get href() {
          return navigatedTo;
        },
      },
      writable: true,
      configurable: true,
    });

    signOut.mockImplementation(async (opts: { fetchOptions: { onSuccess: () => void } }) => {
      opts.fetchOptions.onSuccess();
    });

    const user = userEvent.setup();
    renderWithIntl(<SignOutButton locale="fr" />);
    await user.click(screen.getByRole("button", { name: /sign out/i }));

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(navigatedTo).toBe("/fr/logged-out");
  });

  it("redirects to an explicit redirectTo when provided (mid-flow resume)", async () => {
    let navigatedTo = "";
    Object.defineProperty(window, "location", {
      value: {
        ...originalLocation,
        set href(value: string) {
          navigatedTo = value;
        },
        get href() {
          return navigatedTo;
        },
      },
      writable: true,
      configurable: true,
    });

    signOut.mockImplementation(async (opts: { fetchOptions: { onSuccess: () => void } }) => {
      opts.fetchOptions.onSuccess();
    });

    const user = userEvent.setup();
    renderWithIntl(<SignOutButton locale="en" redirectTo="/en/invite?token=tok-123" />);
    await user.click(screen.getByRole("button", { name: /sign out/i }));

    expect(navigatedTo).toBe("/en/invite?token=tok-123");
  });
});
