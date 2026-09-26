// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsTable } from "@/app/[locale]/(secure)/app/administrator/agents/_agents-table";
import { DialogManagerProvider } from "@/components/ui/dialog-manager";
import { createAppFormatter, systemFormatPreferences } from "@/lib/format/app-format";
import type { McpAgentConsoleRow } from "@/lib/mcp/agents";
import ukMessages from "@/messages/uk.json";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * The MCP agents console table (F-118, I-03).
 *
 * F-118: revoke and set-scopes used the browser's native `confirm` /
 * `prompt`, which cannot be styled or tested, block the thread and show
 * their buttons in the browser's language rather than the app's; they now go
 * through the shared dialog manager and name the agent they act on. A failed
 * action is announced (`role="alert"`).
 *
 * I-03: an approver saw only the registrant-chosen name and client id. Each
 * row now shows the bound organization, the registration time and its source
 * IP, managers get a hint to confirm those and the client id with the
 * agent's operator rather than trust its name, and a legacy name carrying a
 * bidi override is shown with it stripped.
 */
const refresh = vi.fn();
vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ refresh }) }));

const fetchMock = vi.fn();

function agent(overrides: Partial<McpAgentConsoleRow> = {}): McpAgentConsoleRow {
  return {
    clientRowId: "11111111-1111-4111-8111-111111111111",
    clientId: "mcp_client_abc123",
    name: "Acme CI Agent",
    scopes: ["users.read"],
    clientStatus: "active",
    appUserId: "22222222-2222-4222-8222-222222222222",
    userStatus: "pending_approval",
    email: "agent@example.test",
    organizationId: "33333333-3333-4333-8333-333333333333",
    createdAt: "2026-09-20T14:05:00Z",
    status: "pending",
    organizationName: "Acme Corp",
    organizationSlug: "acme",
    registeredIp: "203.0.113.7",
    ...overrides,
  };
}

function renderTable(
  agents: McpAgentConsoleRow[],
  { canManage = true, messages }: { canManage?: boolean; messages?: Record<string, unknown> } = {},
) {
  return renderWithIntl(
    <DialogManagerProvider>
      <AgentsTable agents={agents} canManage={canManage} />
    </DialogManagerProvider>,
    messages ? { locale: "uk", messages } : {},
  );
}

beforeEach(() => {
  refresh.mockReset();
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AgentsTable approval context (I-03)", () => {
  it("shows the organization, registration time and source IP of each agent", () => {
    renderTable([agent()]);
    const row = screen.getByText("Acme CI Agent").closest("tr")!;
    expect(screen.getByRole("columnheader", { name: "Organization" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Registered" })).toBeInTheDocument();
    expect(within(row).getByText("Acme Corp")).toBeInTheDocument();
    expect(within(row).getByText("acme")).toBeInTheDocument();
    expect(within(row).getByText("from 203.0.113.7")).toBeInTheDocument();
    // Through the viewer's formatter (UTC in the test provider), like every admin grid.
    const registered = createAppFormatter("en", systemFormatPreferences("UTC")).dateTime(
      "2026-09-20T14:05:00Z",
    );
    expect(within(row).getByText(registered)).toBeInTheDocument();
  });

  it("says so when the registration's source IP was not recorded", () => {
    renderTable([agent({ registeredIp: null })]);
    expect(screen.getByText("source IP not recorded")).toBeInTheDocument();
  });

  it("tells managers to verify an agent with its operator, not by its name", () => {
    const { unmount } = renderTable([agent()]);
    expect(screen.getByText(/whatever its registrant typed/)).toBeInTheDocument();
    unmount();
    renderTable([agent()], { canManage: false });
    expect(screen.queryByText(/whatever its registrant typed/)).not.toBeInTheDocument();
  });

  it("strips a bidi override from a name stored before the registration rule", () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE would render the rest of the name reversed.
    renderTable([agent({ name: "Acme‮ tnegA IC" })]);
    const row = screen.getByText("Acme tnegA IC").closest("tr")!;
    expect(row.textContent).not.toMatch(/‮/);
  });

  it("falls back to the client id when nothing printable is left of the name", () => {
    renderTable([agent({ name: "‮⁦" })]);
    expect(screen.getAllByText("mcp_client_abc123")).toHaveLength(2);
  });
});

describe("AgentsTable actions (F-118)", () => {
  it("confirms a revoke in the app's own dialog, naming the agent and its client id", async () => {
    const user = userEvent.setup();
    const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderTable([agent()]);

    await user.click(screen.getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Revoke Acme CI Agent?" });
    expect(dialog).toHaveTextContent("mcp_client_abc123");
    expect(nativeConfirm).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/administrator/mcp-agents/11111111-1111-4111-8111-111111111111",
      { method: "DELETE" },
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("sends nothing when the revoke is cancelled", async () => {
    const user = userEvent.setup();
    renderTable([agent()]);
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("edits scopes in the app's own prompt, prefilled with the current ceiling", async () => {
    const user = userEvent.setup();
    const nativePrompt = vi.spyOn(window, "prompt").mockReturnValue("users.read");
    renderTable([agent({ scopes: ["users.read", "audit.read"] })]);

    await user.click(screen.getByRole("button", { name: "Set scopes" }));
    const dialog = await screen.findByRole("dialog", { name: "Set scopes for Acme CI Agent" });
    const input = within(dialog).getByRole("textbox", { name: "Scopes, separated by commas" });
    expect(input).toHaveValue("users.read, audit.read");
    expect(nativePrompt).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, " users.read , ,apikeys.read ");
    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/administrator/mcp-agents/11111111-1111-4111-8111-111111111111",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scopes: ["users.read", "apikeys.read"] }),
      },
    );
  });

  it("announces a failed action", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    renderTable([agent()]);
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The action could not be completed.",
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("asks in the viewer's language, not the browser's", async () => {
    const user = userEvent.setup();
    renderTable([agent()], { messages: ukMessages });
    expect(screen.getByRole("columnheader", { name: "Організація" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Відкликати" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Відкликати Acme CI Agent?" });
    expect(within(dialog).getByRole("button", { name: "Скасувати" })).toBeInTheDocument();
  });
});
