// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSessionsPanel } from "@/app/[locale]/(secure)/app/account/security/_sessions-panel";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * Active-sessions panel accessibility + current-session safety
 * (review #107, #239).
 *
 *  - #107: every row's button announced the same bare "Revoke", so a
 *    screen-reader user had no way to tell which device they were about to
 *    sign out. Each button must now carry a row-identifying accessible
 *    name.
 *  - #239: the panel could not tell which row was the CALLER'S OWN
 *    session, so "Revoke" on it destroyed the live session — the reload
 *    came back 401 and the user was left looking at a generic load error.
 *    The current row must be marked and must not be revocable from here.
 */
const listSessions = vi.fn();
const getSession = vi.fn();
const revokeSession = vi.fn();
const revokeOtherSessions = vi.fn();

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    listSessions: () => listSessions(),
    getSession: () => getSession(),
    revokeSession: (...a: unknown[]) => revokeSession(...a),
    revokeOtherSessions: () => revokeOtherSessions(),
  },
}));

const CURRENT = {
  token: "tok-current",
  ipAddress: "203.0.113.9",
  expiresAt: "2026-10-01T00:00:00.000Z",
};
const OTHER = {
  token: "tok-other",
  ipAddress: "198.51.100.4",
  expiresAt: "2026-11-02T00:00:00.000Z",
};

beforeEach(() => {
  for (const m of [listSessions, getSession, revokeSession, revokeOtherSessions]) m.mockReset();
  listSessions.mockResolvedValue({ data: [CURRENT, OTHER] });
  getSession.mockResolvedValue({ data: { session: { token: "tok-current" } } });
  revokeSession.mockResolvedValue({ data: {} });
});

describe("AccountSessionsPanel", () => {
  it("gives every revoke button a row-identifying accessible name (#107)", async () => {
    renderWithIntl(<AccountSessionsPanel />);
    // Only the non-current row keeps a button; its name names the row.
    const button = await screen.findByRole("button", { name: `Revoke session ${OTHER.ipAddress}` });
    expect(button).toBeInTheDocument();
    // The generic, ambiguous name is gone from the row actions.
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });

  it("falls back to the expiry when a row has no IP address (#107)", async () => {
    listSessions.mockResolvedValue({ data: [CURRENT, { token: "tok-noip", expiresAt: null }] });
    renderWithIntl(<AccountSessionsPanel />);
    expect(await screen.findByRole("button", { name: "Revoke session —" })).toBeInTheDocument();
  });

  it("marks the current session and offers no revoke control for it (#239)", async () => {
    renderWithIntl(<AccountSessionsPanel />);
    expect(await screen.findByText("This device")).toBeInTheDocument();
    expect(screen.getByText("Use Sign out to end this session.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: `Revoke session ${CURRENT.ipAddress}` }),
    ).toBeNull();
  });

  it("revokes only the row the user activated, and never the current token (#239)", async () => {
    renderWithIntl(<AccountSessionsPanel />);
    const button = await screen.findByRole("button", { name: `Revoke session ${OTHER.ipAddress}` });
    await userEvent.setup().click(button);
    await waitFor(() => expect(revokeSession).toHaveBeenCalledTimes(1));
    expect(revokeSession).toHaveBeenCalledWith({ token: "tok-other" });
  });

  it("still lists sessions when the current-session lookup fails (unmarked, but usable)", async () => {
    getSession.mockRejectedValue(new Error("offline"));
    renderWithIntl(<AccountSessionsPanel />);
    expect(
      await screen.findByRole("button", { name: `Revoke session ${OTHER.ipAddress}` }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Revoke session ${CURRENT.ipAddress}` }),
    ).toBeInTheDocument();
    expect(screen.queryByText("This device")).toBeNull();
  });
});
