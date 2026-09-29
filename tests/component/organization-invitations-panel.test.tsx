// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * The organization Invitations panel's resend action. F-149: the resend route
 * refuses (409 `invitation_inviter_lacks_standing`) an invitation whose
 * original inviter can no longer invite, after voiding it. The panel says so,
 * telling the admin to send a new one, and reloads the grid so the row reads
 * Revoked instead of still offering Resend.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/en/app/administrator",
  useSearchParams: () => new URLSearchParams(""),
  redirect: vi.fn(),
  permanentRedirect: vi.fn(),
  notFound: vi.fn(),
}));
vi.mock("@/components/ui/dialog-manager", () => ({
  useDialogs: () => ({ confirm: () => Promise.resolve(true) }),
}));

import { OrganizationInvitationsPanel } from "@/app/[locale]/(secure)/app/administrator/organizations/[orgId]/_organization-invitations-panel";

const fetchMock = vi.fn();

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** How many times the grid read the invitations list. */
function listReads(): number {
  return fetchMock.mock.calls.filter(
    ([input, init]) =>
      !(init as { method?: string } | undefined)?.method &&
      new URL(String(input), "http://test.local").pathname ===
        "/api/administrator/organizations/o1/invitations",
  ).length;
}

const ROW = {
  id: "i1",
  email: "carol@corp.test",
  role_name: null,
  invited_by_display_name: "Former Admin",
  expires_at: "2026-10-01T00:00:00Z",
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("OrganizationInvitationsPanel resend (F-149)", () => {
  it("says the inviter can no longer invite and reloads the voided row", async () => {
    let status = "pending";
    fetchMock.mockImplementation(async (input: unknown, init?: { method?: string }) => {
      const url = new URL(String(input), "http://test.local");
      if (url.pathname.endsWith("/resend") && init?.method === "POST") {
        status = "revoked"; // the server voided it before answering
        return json(
          {
            error: "invitation_inviter_lacks_standing",
            message: "errors.invitation_inviter_lacks_standing",
          },
          409,
        );
      }
      return json({ items: [{ ...ROW, status }], page: 1, pageSize: 10, total: 1, sort: [] });
    });
    const user = userEvent.setup();
    renderWithIntl(<OrganizationInvitationsPanel orgId="o1" canUpdate canReadRoles />);

    await user.click(await screen.findByRole("button", { name: "Resend" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The administrator who sent this invitation can no longer invite, so it has been revoked. Send a new invitation.",
    );
    // The grid read the list again and now shows the voided row as such.
    expect(await screen.findByText("revoked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resend" })).toBeNull();
    expect(listReads()).toBe(2);
  });
});

describe("OrganizationInvitationsPanel budgets (F-64)", () => {
  const tooMany = () => json({ error: "rate_limited", retryAfter: 420 }, 429);

  it("says so when a resend is refused by the cooldown or the org's mail budget", async () => {
    fetchMock.mockImplementation(async (input: unknown, init?: { method?: string }) => {
      const url = new URL(String(input), "http://test.local");
      if (url.pathname.endsWith("/resend") && init?.method === "POST") return tooMany();
      return json({
        items: [{ ...ROW, status: "pending" }],
        page: 1,
        pageSize: 10,
        total: 1,
        sort: [],
      });
    });
    const user = userEvent.setup();
    renderWithIntl(<OrganizationInvitationsPanel orgId="o1" canUpdate canReadRoles />);

    await user.click(await screen.findByRole("button", { name: "Resend" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many requests. Please slow down.",
    );
  });

  it("says so when an invitation is refused by the org's mail budget", async () => {
    fetchMock.mockImplementation(async (input: unknown, init?: { method?: string }) => {
      const url = new URL(String(input), "http://test.local");
      if (
        url.pathname === "/api/administrator/organizations/o1/invitations" &&
        init?.method === "POST"
      ) {
        return tooMany();
      }
      return json({ items: [], page: 1, pageSize: 10, total: 0, sort: [] });
    });
    const user = userEvent.setup();
    renderWithIntl(<OrganizationInvitationsPanel orgId="o1" canUpdate canReadRoles />);

    await user.click(await screen.findByRole("button", { name: "Invite member" }));
    await user.type(await screen.findByRole("textbox", { name: /Email address/ }), "ada@corp.test");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many requests. Please slow down.",
    );
  });
});

/**
 * F-67: the invite dialog's role select reads GET /api/administrator/roles,
 * which needs `admin.roles.read`; the organization page checks only
 * `admin.orgs.*`. Without the permission the roles are neither requested nor
 * offered, and the invitation is sent without one.
 */
describe("OrganizationInvitationsPanel role select (F-67)", () => {
  it("neither reads nor offers roles without admin.roles.read", async () => {
    fetchMock.mockImplementation(async (input: unknown, init?: { method?: string }) => {
      const url = new URL(String(input), "http://test.local");
      if (url.pathname === "/api/administrator/roles") return json({}, 403);
      if (init?.method === "POST") return json({ ok: true }, 201);
      return json({ items: [], page: 1, pageSize: 10, total: 0, sort: [] });
    });
    const user = userEvent.setup();
    renderWithIntl(<OrganizationInvitationsPanel orgId="o1" canUpdate canReadRoles={false} />);

    await user.click(await screen.findByRole("button", { name: "Invite member" }));
    await user.type(await screen.findByRole("textbox", { name: /Email address/ }), "ada@corp.test");
    expect(screen.queryByText("Role (optional)")).not.toBeInTheDocument();
    expect(screen.queryByText(/Roles couldn't be loaded/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send invitation" }));

    expect(await screen.findByText("Invitation sent.")).toBeInTheDocument();
    const paths = fetchMock.mock.calls.map(
      ([input]) => new URL(String(input), "http://x").pathname,
    );
    expect(paths).not.toContain("/api/administrator/roles");
    const post = fetchMock.mock.calls.find(
      ([, init]) => (init as { method?: string } | undefined)?.method === "POST",
    );
    expect(JSON.parse((post![1] as { body: string }).body)).toEqual({
      email: "ada@corp.test",
      roleId: null,
    });
  });
});
