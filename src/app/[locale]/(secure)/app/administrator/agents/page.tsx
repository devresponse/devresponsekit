import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { listMcpAgents } from "@/lib/mcp/agents.server";
import { AgentsTable } from "./_agents-table";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/administrator/agents
 *
 * Lifecycle console for self-registered MCP agents (design
 * docs/design-mcp-agent-gateway.md §12). Read needs `admin.clients.read`;
 * the approve / set-scopes / revoke actions are gated client-side on
 * `admin.clients.manage` and re-checked on every API route.
 */
export default async function AdministratorAgentsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const guard = await checkAdminPermissionServer("admin.clients.read");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }
  const canManage = guard.access.permissions.includes("admin.clients.manage");
  const agents = await listMcpAgents(guard.access);

  const t = await getTranslations({ locale, namespace: "administrator.agents" });

  return (
    <section className="space-y-4 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>
      <AgentsTable agents={agents} canManage={canManage} />
    </section>
  );
}
