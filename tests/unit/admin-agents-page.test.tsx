import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AgentsServer from "@/lib/mcp/agents.server";
import type * as PageModule from "@/app/[locale]/(secure)/app/administrator/agents/page";

/**
 * F-63 on the MCP agents console, the one admin PAGE that parses a list query
 * itself (`?page=` through the shared `parseMcpAgentListQuery`).
 *
 * `?page=99999999999999999999` reached Postgres as an OFFSET past `bigint`, so
 * the page rendered the error boundary and filed a Sentry event. The parser
 * now refuses a page past MAX_PAGE by throwing `InvalidListQueryError`, which
 * the API route answers 400; the page has no 400 and answers `notFound()`,
 * before any query runs. `notFound` is mocked to throw a sentinel, as Next's
 * own does.
 */
const NOT_FOUND = "__NOT_FOUND_SENTINEL__";
const notFoundMock = vi.fn(() => {
  throw new Error(NOT_FOUND);
});
const checkAdminPermissionServer = vi.fn();
const listMcpAgents = vi.fn();
const getTranslations = vi.fn();

vi.mock("next/navigation", () => ({ notFound: () => notFoundMock() }));
vi.mock("next-intl/server", () => ({
  getTranslations: (...a: unknown[]) => getTranslations(...a),
}));
vi.mock("@/lib/admin/permissions.server", () => ({
  checkAdminPermissionServer: (...a: unknown[]) => checkAdminPermissionServer(...a),
}));
vi.mock("@/db/database", () => ({ db: {} }));
// The real parser and status filter; only the query is replaced.
vi.mock("@/lib/mcp/agents.server", async () => {
  const actual = await vi.importActual<typeof AgentsServer>("@/lib/mcp/agents.server");
  return { ...actual, listMcpAgents: (...a: unknown[]) => listMcpAgents(...a) };
});
// Client islands: the page only forwards props; they are not under test.
vi.mock("@/app/[locale]/(secure)/app/administrator/agents/_agents-table", () => ({
  AgentsTable: () => null,
}));
vi.mock("@/app/[locale]/(secure)/app/administrator/agents/_agents-toolbar", () => ({
  AgentsToolbar: () => null,
}));

const ACCESS = {
  appUserId: "admin-app-1",
  primaryEmail: "admin@x.com",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["superuser", "admin.clients.read"],
};

let Page: typeof PageModule.default;

function props(searchParams: { page?: string; status?: string }) {
  return {
    params: Promise.resolve({ locale: "en" }),
    searchParams: Promise.resolve(searchParams),
  };
}

beforeEach(async () => {
  for (const m of [checkAdminPermissionServer, listMcpAgents, getTranslations]) m.mockReset();
  notFoundMock.mockClear();
  checkAdminPermissionServer.mockResolvedValue({ betterAuthUserId: "ba-admin", access: ACCESS });
  listMcpAgents.mockImplementation(async (_access: unknown, query: { page: number }) => ({
    items: [],
    page: query.page,
    pageSize: 25,
    total: 0,
    sort: [],
    pendingCount: 0,
  }));
  getTranslations.mockResolvedValue((key: string) => key);
  ({ default: Page } = await import("@/app/[locale]/(secure)/app/administrator/agents/page"));
});
afterEach(() => vi.resetModules());

describe("administrator/agents page — `?page=` past MAX_PAGE (F-63)", () => {
  it("answers notFound() before listing, where it used to reach Postgres", async () => {
    for (const page of ["1000001", "99999999999999999999"]) {
      await expect(Page(props({ page })), page).rejects.toThrow(NOT_FOUND);
    }
    expect(listMcpAgents).not.toHaveBeenCalled();
  });

  it("still lists an ordinary page (and reads a nonsense one as page 1)", async () => {
    await Page(props({ page: "3", status: "pending" }));
    await Page(props({ page: "abc" }));
    expect(notFoundMock).not.toHaveBeenCalled();
    expect(listMcpAgents.mock.calls.map(([, query]) => (query as { page: number }).page)).toEqual([
      3, 1,
    ]);
  });
});
