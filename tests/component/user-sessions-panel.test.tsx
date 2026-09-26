// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * F-158: "Revoke all sessions" on a user's Sessions tab ran on one click, and
 * on the admin's own user page it signed them out of the browser they were
 * using without a word. Both revokes now ask first, and say so when the
 * target is the viewer.
 */
const confirmMock = vi.fn();
vi.mock("@/components/ui/dialog-manager", () => ({
  useDialogs: () => ({ confirm: confirmMock }),
}));

import { UserSessionsPanel } from "@/app/[locale]/(secure)/app/administrator/users/[userId]/_user-sessions-panel";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const LIST = `/api/administrator/users/${USER_ID}/sessions`;
const fetchMock = vi.fn();

function deletes(): string[] {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as { method?: string } | undefined)?.method === "DELETE")
    .map(([input]) => String(input));
}

beforeEach(() => {
  confirmMock.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: unknown, init?: { method?: string }) => {
    if (init?.method === "DELETE") return { ok: true, status: 200, json: async () => ({}) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        sessions: [
          {
            id: "s1",
            expiresAt: "2026-10-01T12:00:00.000Z",
            ipAddress: "10.0.0.1",
            userAgent: "Firefox",
          },
        ],
      }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function renderPanel(isSelf: boolean) {
  const user = userEvent.setup();
  renderWithIntl(<UserSessionsPanel userId={USER_ID} isSelf={isSelf} />);
  await screen.findByText(/Firefox/);
  return user;
}

describe("UserSessionsPanel — Revoke all asks first (F-158)", () => {
  it("does nothing when the admin cancels", async () => {
    confirmMock.mockResolvedValue(false);
    const user = await renderPanel(false);
    await user.click(screen.getByRole("button", { name: "Revoke all sessions" }));

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0]![0]).toMatchObject({
      title: "Revoke all of this user's sessions?",
      description: "They will be signed out on every device and must sign in again.",
      confirmLabel: "Revoke all sessions",
      destructive: true,
    });
    expect(deletes()).toEqual([]);
  });

  it("revokes every session once confirmed", async () => {
    confirmMock.mockResolvedValue(true);
    const user = await renderPanel(false);
    await user.click(screen.getByRole("button", { name: "Revoke all sessions" }));
    await waitFor(() => expect(deletes()).toEqual([LIST]));
  });

  it("warns that the admin signs themselves out on their own user page", async () => {
    confirmMock.mockResolvedValue(false);
    const user = await renderPanel(true);
    await user.click(screen.getByRole("button", { name: "Revoke all sessions" }));
    expect(confirmMock.mock.calls[0]![0]).toMatchObject({
      description:
        "This is your own account: you will be signed out here and on every other device.",
      destructive: true,
    });
    expect(deletes()).toEqual([]);
  });
});

describe("UserSessionsPanel — a single Revoke asks first (F-158)", () => {
  it("does nothing when the admin cancels, and revokes that session once confirmed", async () => {
    confirmMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const user = await renderPanel(false);

    await user.click(screen.getByRole("button", { name: "Revoke" }));
    expect(confirmMock.mock.calls[0]![0]).toMatchObject({
      title: "Revoke this session?",
      confirmLabel: "Revoke",
      destructive: true,
    });
    expect(confirmMock.mock.calls[0]![0].description).toMatch(/^Expires /);
    expect(deletes()).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(deletes()).toEqual([`${LIST}/s1`]));
  });

  it("warns on the admin's own user page that it may be the session they are using", async () => {
    confirmMock.mockResolvedValue(false);
    const user = await renderPanel(true);
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    expect(confirmMock.mock.calls[0]![0].description).toBe(
      "This is your own account. If this is the session you are using, you will be signed out.",
    );
  });
});
