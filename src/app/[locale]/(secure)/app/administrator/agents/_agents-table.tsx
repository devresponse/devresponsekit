"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import type { McpAgentSummary } from "@/lib/mcp/agents";

/**
 * Client table for the MCP-agents console. Renders ONE PAGE of the
 * org-scoped agent inventory the server page fetched (review #13 — paging
 * and the status filter live in `_agents-toolbar.tsx`), and — for
 * `admin.clients.manage` holders — the approve / set-scopes / revoke
 * actions, each a same-origin call to the cookie-session admin API followed
 * by a router refresh. `filtered` picks the empty-state copy: "no agents
 * match this filter" vs "none registered yet".
 */
export function AgentsTable({
  agents,
  canManage,
  filtered = false,
}: {
  agents: McpAgentSummary[];
  canManage: boolean;
  filtered?: boolean;
}) {
  const t = useTranslations("administrator.agents");
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(key: string, url: string, init: RequestInit): Promise<void> {
    setBusy(key);
    setError(null);
    try {
      const response = await fetch(url, init);
      if (!response.ok) {
        setError(t("actionFailed"));
        return;
      }
      router.refresh();
    } catch {
      setError(t("actionFailed"));
    } finally {
      setBusy(null);
    }
  }

  function approve(agent: McpAgentSummary): void {
    void run(
      `${agent.clientRowId}:approve`,
      `/api/administrator/mcp-agents/${agent.clientRowId}/approve`,
      {
        method: "POST",
      },
    );
  }

  function revoke(agent: McpAgentSummary): void {
    if (!window.confirm(t("confirmRevoke"))) return;
    void run(`${agent.clientRowId}:revoke`, `/api/administrator/mcp-agents/${agent.clientRowId}`, {
      method: "DELETE",
    });
  }

  function setScopes(agent: McpAgentSummary): void {
    const input = window.prompt(t("scopesPrompt"), agent.scopes.join(", "));
    if (input === null) return;
    const scopes = input
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
    void run(`${agent.clientRowId}:scopes`, `/api/administrator/mcp-agents/${agent.clientRowId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopes }),
    });
  }

  if (agents.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">{filtered ? t("emptyFiltered") : t("empty")}</p>
    );
  }

  return (
    <div className="overflow-x-auto">
      {error ? <p className="text-destructive mb-2 text-sm">{error}</p> : null}
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-muted-foreground border-b text-left text-xs uppercase">
            <th className="p-2 font-medium">{t("colName")}</th>
            <th className="p-2 font-medium">{t("colStatus")}</th>
            <th className="p-2 font-medium">{t("colScopes")}</th>
            {canManage ? <th className="p-2 text-right font-medium">{t("colActions")}</th> : null}
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => {
            // `status` is derived server-side from the client + user rows
            // (see McpAgentStatus) so the badge, filter and sort agree.
            const pending = agent.status === "pending";
            const revoked = agent.status === "revoked";
            const status = pending
              ? t("statusPending")
              : revoked
                ? t("statusRevoked")
                : t("statusActive");
            return (
              <tr key={agent.clientRowId} className="border-b align-top">
                <td className="p-2">
                  <div className="font-medium">{agent.name}</div>
                  <div className="text-muted-foreground font-mono text-xs">{agent.clientId}</div>
                </td>
                <td className="p-2 text-xs">{status}</td>
                <td className="p-2">
                  <span className="font-mono text-xs">
                    {agent.scopes.length > 0 ? agent.scopes.join(", ") : t("noScopes")}
                  </span>
                </td>
                {canManage ? (
                  <td className="space-x-2 p-2 text-right whitespace-nowrap">
                    {pending ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => approve(agent)}
                      >
                        {t("approve")}
                      </Button>
                    ) : null}
                    {!revoked ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => setScopes(agent)}
                      >
                        {t("setScopes")}
                      </Button>
                    ) : null}
                    {!revoked ? (
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy !== null}
                        onClick={() => revoke(agent)}
                      >
                        {t("revoke")}
                      </Button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
