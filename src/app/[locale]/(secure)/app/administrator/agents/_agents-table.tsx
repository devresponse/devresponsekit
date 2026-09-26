"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useAppFormatter } from "@/components/i18n/format-preferences";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/dialog-manager";
import { useRouter } from "@/i18n/navigation";
import type { McpAgentConsoleRow } from "@/lib/mcp/agents";
import { sanitizeUserName } from "@/lib/user-name";

/**
 * The name a row shows for an agent. `client_name` has been parsed with the
 * shared name rule since F-21, but rows registered before that were never
 * rewritten, so it is re-applied here (I-03): a bidi override or an invisible
 * character must not make one agent's name render as another's.
 */
function displayName(agent: McpAgentConsoleRow): string {
  return sanitizeUserName(agent.name) || agent.clientId;
}

/**
 * Client table for the MCP-agents console. Renders ONE PAGE of the
 * org-scoped agent inventory the server page fetched (review #13 — paging
 * and the status filter live in `_agents-toolbar.tsx`), and — for
 * `admin.clients.manage` holders — the approve / set-scopes / revoke
 * actions, each a same-origin call to the cookie-session admin API followed
 * by a router refresh. `filtered` picks the empty-state copy: "no agents
 * match this filter" vs "none registered yet".
 *
 * Each row also shows what an approver needs beyond the registrant-chosen
 * name — the bound organization, the registration time and its source IP
 * (I-03) — and the revoke / set-scopes prompts go through the shared dialog
 * manager, so they are translated, styled and name the agent they act on
 * (F-118).
 */
export function AgentsTable({
  agents,
  canManage,
  filtered = false,
}: {
  agents: McpAgentConsoleRow[];
  canManage: boolean;
  filtered?: boolean;
}) {
  const t = useTranslations("administrator.agents");
  const router = useRouter();
  const dialogs = useDialogs();
  const format = useAppFormatter();
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

  function approve(agent: McpAgentConsoleRow): void {
    void run(
      `${agent.clientRowId}:approve`,
      `/api/administrator/mcp-agents/${agent.clientRowId}/approve`,
      {
        method: "POST",
      },
    );
  }

  async function revoke(agent: McpAgentConsoleRow): Promise<void> {
    const confirmed = await dialogs.confirm({
      title: t("revokeTitle", { name: displayName(agent) }),
      description: t("confirmRevoke", { clientId: agent.clientId }),
      confirmLabel: t("revoke"),
      destructive: true,
    });
    if (!confirmed) return;
    await run(`${agent.clientRowId}:revoke`, `/api/administrator/mcp-agents/${agent.clientRowId}`, {
      method: "DELETE",
    });
  }

  async function setScopes(agent: McpAgentConsoleRow): Promise<void> {
    const input = await dialogs.promptText({
      title: t("scopesTitle", { name: displayName(agent) }),
      description: t("scopesPrompt"),
      label: t("scopesLabel"),
      defaultValue: agent.scopes.join(", "),
    });
    if (input === null) return;
    const scopes = input
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
    await run(`${agent.clientRowId}:scopes`, `/api/administrator/mcp-agents/${agent.clientRowId}`, {
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
      {canManage ? <p className="text-muted-foreground mb-2 text-sm">{t("verifyHint")}</p> : null}
      {error ? (
        <p className="text-destructive mb-2 text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-muted-foreground border-b text-left text-xs uppercase">
            <th className="p-2 font-medium">{t("colName")}</th>
            <th className="p-2 font-medium">{t("colOrganization")}</th>
            <th className="p-2 font-medium">{t("colRegistered")}</th>
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
                  <div className="font-medium">{displayName(agent)}</div>
                  <div className="text-muted-foreground font-mono text-xs">{agent.clientId}</div>
                </td>
                <td className="p-2">
                  <div>{agent.organizationName ?? "—"}</div>
                  {agent.organizationSlug ? (
                    <div className="text-muted-foreground font-mono text-xs">
                      {agent.organizationSlug}
                    </div>
                  ) : null}
                </td>
                <td className="p-2 whitespace-nowrap">
                  <div>{format.dateTime(agent.createdAt)}</div>
                  <div className="text-muted-foreground text-xs">
                    {agent.registeredIp
                      ? t("registeredFrom", { ip: agent.registeredIp })
                      : t("registeredIpUnknown")}
                  </div>
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
                        onClick={() => void setScopes(agent)}
                      >
                        {t("setScopes")}
                      </Button>
                    ) : null}
                    {!revoked ? (
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy !== null}
                        onClick={() => void revoke(agent)}
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
