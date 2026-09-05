import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import {
  listMcpAgents,
  mcpAgentStatusFilter,
  parseMcpAgentListQuery,
} from "@/lib/mcp/agents.server";
import { AgentsTable } from "./_agents-table";
import { AgentsToolbar } from "./_agents-toolbar";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/administrator/agents
 *
 * Lifecycle console for self-registered MCP agents (design
 * docs/design-mcp-agent-gateway.md §12). Read needs `admin.clients.read`;
 * the approve / set-scopes / revoke actions are gated client-side on
 * `admin.clients.manage` and re-checked on every API route.
 *
 * Paged and filterable (review #13): `?page=` and `?status=pending|active|
 * revoked` ride the URL (the same page/filter contract as the admin API,
 * parsed by the shared `parseMcpAgentListQuery`), pending agents always sort
 * first, and a scope-wide pending badge shows what needs attention even when
 * a flood of junk registrations pushes it off the current page.
 */
export default async function AdministratorAgentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ page?: string; status?: string }>;
}) {
  const { locale } = await params;
  const guard = await checkAdminPermissionServer("admin.clients.read");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }
  const canManage = guard.access.permissions.includes("admin.clients.manage");

  // Same parser as the API route: `?status=` is the console's short form of
  // `filter[status]`; anything unrecognised is dropped there (→ "All").
  const requested = await searchParams;
  const urlParams = new URLSearchParams();
  if (requested.page) urlParams.set("page", requested.page);
  if (requested.status) urlParams.set("filter[status]", requested.status);
  const query = parseMcpAgentListQuery(urlParams);
  const result = await listMcpAgents(guard.access, query);
  const activeStatus = mcpAgentStatusFilter(query);

  const t = await getTranslations({ locale, namespace: "administrator.agents" });

  return (
    <section className="space-y-4 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>
      <AgentsToolbar
        activeStatus={activeStatus}
        pendingCount={result.pendingCount}
        page={result.page}
        pageSize={result.pageSize}
        total={result.total}
      />
      <AgentsTable agents={result.items} canManage={canManage} filtered={activeStatus !== null} />
    </section>
  );
}
