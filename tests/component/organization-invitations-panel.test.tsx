// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * F-156: the organization invitations panel collapsed every refusal into
 * "Could not send / resend / revoke the invitation.". Inviting into a role the
 * admin may not confer (403 `forbidden`, AUTHZ-3), a role deleted since the
 * dialog listed it (404 `role_not_found`), the rate limit (429) and an
 * invitation accepted or revoked meanwhile (404 `invitation_not_found`) all
 * read the same, and a dropped connection during resend or revoke rejected
 * the click handler with nothing on screen. These drive the real panel and
 * grid against a fake API.
 *
 * Also F-116: the grid's status badges are translated.
 *
 * And F-149: the resend route refuses (409 `invitation_inviter_lacks_standing`)
 * an invitation whose original inviter can no longer invite, after voiding it.
 * The panel says so, telling the admin to send a new one, and reloads the grid
 * so the row reads Revoked instead of still offering Resend.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/en/app/administrator/organizations/o1",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/components/ui/dialog-manager", () => ({
  useDialogs: () => ({ confirm: () => Promise.resolve(true) }),
}));

import { OrganizationInvitationsPanel } from "@/app/[locale]/(secure)/app/administrator/organizations/[orgId]/_organization-invitations-panel";

const LIST = "/api/administrator/organizations/o1/invitations";
// The invitation schema validates the role id as a UUID.
const ROLE_ID = "11111111-1111-4111-8111-111111111111";
const ROWS = [
  {
    id: "i1",
    email: "pending@x.test",
    status: "pending",
    role_name: null,
    invited_by_display_name: "Ada",
    expires_at: "2026-10-01T00:00:00.000Z",
  },
  {
    id: "i2",
    email: "late@x.test",
    status: "expired",
    role_name: null,
    invited_by_display_name: "Ada",
    expires_at: "2026-09-01T00:00:00.000Z",
  },
];

type Answer = { status: number; body?: unknown } | "network";

const fetchMock = vi.fn();
/** What the next POST / resend / DELETE answers. */
let answers: { invite: Answer; resend: Answer; revoke: Answer };

function res(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Headers(),
  };
}

/** The budget (F-64) and role-select (F-67) suites' spelling of {@link res}. */
function json(body: unknown, status = 200) {
  return res(status, body);
}

/** The pending row those suites route their own list answers from. */
const ROW = ROWS[0];

function reply(answer: Answer) {
  if (answer === "network") return Promise.reject(new TypeError("Failed to fetch"));
  return Promise.resolve(res(answer.status, answer.body));
}

/** How many times the grid has read the invitations list. */
function listReads(): number {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const url = new URL(String(input), "http://test.local");
    return url.pathname === LIST && !(init as { method?: string } | undefined)?.method;
  }).length;
}

beforeEach(() => {
  answers = {
    invite: { status: 201, body: { ok: true } },
    resend: { status: 200, body: { ok: true } },
    revoke: { status: 200, body: { ok: true } },
  };
  fetchMock.mockReset();
  fetchMock.mockImplementation((input: unknown, init?: { method?: string }) => {
    const url = new URL(String(input), "http://test.local");
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/administrator/roles") {
      return Promise.resolve(
        res(200, { items: [{ id: ROLE_ID, name: "Support" }], page: 1, pageSize: 200, total: 1 }),
      );
    }
    if (url.pathname === LIST && method === "GET") {
      return Promise.resolve(res(200, { items: ROWS, page: 1, pageSize: 10, total: ROWS.length }));
    }
    if (url.pathname === LIST && method === "POST") return reply(answers.invite);
    if (url.pathname === `${LIST}/i1/resend` && method === "POST") return reply(answers.resend);
    if (url.pathname === `${LIST}/i1` && method === "DELETE") return reply(answers.revoke);
    return Promise.reject(new Error(`unrouted fetch: ${method} ${url.pathname}`));
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function renderPanel() {
  const user = userEvent.setup();
  renderWithIntl(<OrganizationInvitationsPanel orgId="o1" canUpdate canReadRoles />);
  await screen.findByText("pending@x.test");
  return user;
}

async function invite(user: ReturnType<typeof userEvent.setup>, withRole = false) {
  await user.click(screen.getByRole("button", { name: "Invite member" }));
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(within(dialog).queryByText("Loading roles…")).toBeNull());
  await user.type(within(dialog).getByRole("textbox", { name: /email address/i }), "new@x.test");
  if (withRole) {
    await user.click(within(dialog).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Support" }));
  }
  await user.click(within(dialog).getByRole("button", { name: "Send invitation" }));
  return dialog;
}

describe("Invite: refusals are named (F-156)", () => {
  it("403 forbidden (a role the admin may not confer) says the action is not permitted", async () => {
    answers.invite = { status: 403, body: { error: "forbidden" } };
    const user = await renderPanel();
    const dialog = await invite(user, true);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "You do not have permission to perform this action.",
    );
  });

  it("429 rate_limited says to slow down", async () => {
    answers.invite = { status: 429, body: { error: "rate_limited", retryAfter: 30 } };
    const user = await renderPanel();
    const dialog = await invite(user);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Too many requests. Please slow down.",
    );
  });

  it("404 role_not_found is shown on the Role field", async () => {
    answers.invite = { status: 404, body: { error: "role_not_found" } };
    const user = await renderPanel();
    const dialog = await invite(user, true);
    // On the Role field (its FormMessage, wired to the trigger), not in the
    // form-level alert that every other refusal uses.
    const role = within(dialog).getByRole("combobox");
    await waitFor(() => expect(role).toHaveAttribute("aria-invalid", "true"));
    expect(role).toHaveAccessibleDescription(/Role not found\./);
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(within(dialog).queryByText("Could not send the invitation.")).toBeNull();
    const post = fetchMock.mock.calls.find(
      ([, init]) => (init as { method?: string } | undefined)?.method === "POST",
    );
    expect(JSON.parse((post![1] as { body: string }).body)).toEqual({
      email: "new@x.test",
      roleId: ROLE_ID,
    });
  });

  it("a 5xx keeps the generic send error", async () => {
    answers.invite = { status: 500, body: { error: "internal_error" } };
    const user = await renderPanel();
    const dialog = await invite(user);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Could not send the invitation.",
    );
  });
});

describe("Resend and revoke: refusals are named, a gone row reloads, a dropped connection shows (F-156)", () => {
  it("resend of an invitation no longer pending says so and reloads the list", async () => {
    answers.resend = { status: 404, body: { error: "invitation_not_found" } };
    const user = await renderPanel();
    const before = listReads();
    await user.click(screen.getByRole("button", { name: "Resend" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invitation not found.");
    await waitFor(() => expect(listReads()).toBe(before + 1));
  });

  it("resend refused with 403 says the action is not permitted, and does not reload", async () => {
    answers.resend = { status: 403, body: { error: "forbidden" } };
    const user = await renderPanel();
    const before = listReads();
    await user.click(screen.getByRole("button", { name: "Resend" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You do not have permission to perform this action.",
    );
    expect(listReads()).toBe(before);
  });

  it("revoke over the rate limit says to slow down", async () => {
    answers.revoke = { status: 429, body: { error: "rate_limited", retryAfter: 30 } };
    const user = await renderPanel();
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many requests. Please slow down.",
    );
  });

  it("revoke of an invitation no longer pending reloads the list", async () => {
    answers.revoke = { status: 404, body: { error: "invitation_not_found" } };
    const user = await renderPanel();
    const before = listReads();
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invitation not found.");
    await waitFor(() => expect(listReads()).toBe(before + 1));
  });

  it("a dropped connection shows the revoke error instead of rejecting unhandled", async () => {
    answers.revoke = "network";
    const user = await renderPanel();
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not revoke the invitation.");
  });

  it("a dropped connection shows the resend error instead of rejecting unhandled", async () => {
    answers.resend = "network";
    const user = await renderPanel();
    await user.click(screen.getByRole("button", { name: "Resend" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not resend the invitation.");
  });
});

describe("Invitation status badges (F-116)", () => {
  it("are translated, not the raw status", async () => {
    await renderPanel();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Expired")).toBeInTheDocument();
    expect(screen.queryByText("expired")).toBeNull();
  });
});

describe("Resend: an inviter without standing (F-149)", () => {
  it("says the inviter can no longer invite and reloads the voided row", async () => {
    let status = "pending";
    fetchMock.mockImplementation((input: unknown, init?: { method?: string }) => {
      const url = new URL(String(input), "http://test.local");
      if (url.pathname === `${LIST}/i1/resend` && init?.method === "POST") {
        status = "revoked"; // the server voided it before answering
        return Promise.resolve(
          res(409, {
            error: "invitation_inviter_lacks_standing",
            message: "errors.invitation_inviter_lacks_standing",
          }),
        );
      }
      if (url.pathname === LIST && !init?.method) {
        return Promise.resolve(
          res(200, {
            items: [{ ...ROWS[0], invited_by_display_name: "Former Admin", status }],
            page: 1,
            pageSize: 10,
            total: 1,
            sort: [],
          }),
        );
      }
      return Promise.reject(new Error(`unrouted fetch: ${init?.method ?? "GET"} ${url.pathname}`));
    });
    const user = await renderPanel();

    await user.click(screen.getByRole("button", { name: "Resend" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The administrator who sent this invitation can no longer invite, so it has been revoked. Send a new invitation.",
    );
    // The grid read the list again and now shows the voided row as such.
    expect(await screen.findByText("Revoked")).toBeInTheDocument();
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
