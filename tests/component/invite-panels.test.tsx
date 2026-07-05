// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  InviteAcceptPanel,
  InviteGuestPanel,
  InviteInvalidPanel,
  InviteMismatchPanel,
} from "@/components/auth/invite-panels";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * Component tests for the invite page panels (0008): the guest CTAs carry
 * the token into sign-up and the return path into sign-in; the accept
 * panel posts the token and hard-navigates on success; the invalid and
 * mismatch panels stay generic.
 */
const fetchMock = vi.fn();
const assignMock = vi.fn();

let signOutProps: { locale?: string; redirectTo?: string } = {};
vi.mock("@/components/auth/sign-out-button", () => ({
  SignOutButton: (props: { locale?: string; redirectTo?: string }) => {
    signOutProps = props;
    return <button type="button">Sign out</button>;
  },
}));

beforeEach(() => {
  fetchMock.mockReset();
  assignMock.mockReset();
  signOutProps = {};
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", { ...window.location, assign: assignMock });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("InviteInvalidPanel", () => {
  it("shows the generic invalid/expired message", () => {
    renderWithIntl(<InviteInvalidPanel />);
    expect(screen.getByText(/invalid or has expired/i)).toBeInTheDocument();
  });
});

describe("InviteGuestPanel", () => {
  it("routes create-account with the token and sign-in with the return path", () => {
    renderWithIntl(<InviteGuestPanel locale="en" organizationName="Acme" token="tok-123" />);
    expect(screen.getByText(/invited to join Acme/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /create account/i })).toHaveAttribute(
      "href",
      "/en/sign-up?invite=tok-123",
    );
    expect(screen.getByRole("link", { name: /sign in to accept/i })).toHaveAttribute(
      "href",
      `/en/sign-in?returnTo=${encodeURIComponent("/en/invite?token=tok-123")}`,
    );
  });
});

describe("InviteMismatchPanel", () => {
  it("explains without echoing the invited address and offers sign-out", () => {
    renderWithIntl(<InviteMismatchPanel locale="en" token="tok-123" />);
    expect(screen.getByText(/issued for a different email address/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
  });

  it("points sign-out back at the invite page so the flow resumes (not a dead-end)", () => {
    renderWithIntl(<InviteMismatchPanel locale="en" token="tok-123" />);
    // Sign-out must carry a resume target back to /invite?token=… rather than
    // defaulting to /logged-out and stranding the user.
    expect(signOutProps.redirectTo).toBe("/en/invite?token=tok-123");
  });
});

describe("InviteAcceptPanel", () => {
  it("posts the token and navigates to the app on success", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const user = userEvent.setup();
    renderWithIntl(
      <InviteAcceptPanel
        locale="en"
        organizationName="Acme"
        email="ada@example.com"
        token="tok-123"
      />,
    );

    await user.click(screen.getByRole("button", { name: /accept invitation/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/invitations/accept",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "tok-123" }),
      }),
    );
    expect(assignMock).toHaveBeenCalledWith("/en/app");
  });

  it("shows an error and stays put when the accept fails", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "invitation_invalid" }),
    });
    const user = userEvent.setup();
    renderWithIntl(
      <InviteAcceptPanel
        locale="en"
        organizationName="Acme"
        email="ada@example.com"
        token="tok-123"
      />,
    );

    await user.click(screen.getByRole("button", { name: /accept invitation/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not accept/i);
    expect(assignMock).not.toHaveBeenCalled();
  });
});
