"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LocaleLink } from "@/components/i18n/locale-link";
import { MCP_AGENT_STATUSES, type McpAgentStatus } from "@/lib/mcp/agents";

const BASE_PATH = "/app/administrator/agents";

/** `?status=…&page=…` for the console, omitting defaults so URLs stay clean. */
function hrefFor(status: McpAgentStatus | null, page: number): string {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `${BASE_PATH}?${qs}` : BASE_PATH;
}

/**
 * Status filter tabs (All / Pending / Active / Revoked), the scope-wide
 * pending badge, and Previous / Next paging for the agents console
 * (review #13). Filter + page live in the URL (server-rendered links, no
 * client state), matching the URL-backed filter convention of the admin
 * grids (docs/admin-manager.md §10), so a view survives refresh / share /
 * back-forward. Changing the filter resets to page 1.
 */
export function AgentsToolbar({
  activeStatus,
  pendingCount,
  page,
  pageSize,
  total,
}: {
  activeStatus: McpAgentStatus | null;
  pendingCount: number;
  page: number;
  pageSize: number;
  total: number;
}) {
  const t = useTranslations("administrator.agents");
  const tGrid = useTranslations("administrator.grid");
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const filterLabels: Record<McpAgentStatus, string> = {
    pending: t("filterPending"),
    active: t("filterActive"),
    revoked: t("filterRevoked"),
  };
  const filters: Array<{ status: McpAgentStatus | null; label: string }> = [
    { status: null, label: t("filterAll") },
    ...MCP_AGENT_STATUSES.map((status) => ({ status, label: filterLabels[status] })),
  ];

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <nav aria-label={t("filterLabel")} className="flex flex-wrap items-center gap-1">
        {filters.map(({ status, label }) => {
          const active = status === activeStatus;
          return (
            <Button
              key={status ?? "all"}
              asChild
              size="sm"
              variant={active ? "outline" : "ghost"}
              aria-current={active ? "page" : undefined}
            >
              <LocaleLink href={hrefFor(status, 1)}>
                {label}
                {status === "pending" && pendingCount > 0 ? (
                  <Badge variant="destructive" className="ml-1.5" data-testid="pending-badge">
                    {pendingCount}
                  </Badge>
                ) : null}
              </LocaleLink>
            </Button>
          );
        })}
      </nav>
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <span>{t("pendingSummary", { count: pendingCount })}</span>
        <span aria-hidden="true">·</span>
        <span>{tGrid("totalRows", { count: total })}</span>
        <span aria-hidden="true">·</span>
        <span>{tGrid("pageOf", { page, totalPages })}</span>
        {page > 1 ? (
          <Button asChild size="sm" variant="outline">
            <LocaleLink href={hrefFor(activeStatus, page - 1)}>{tGrid("previousPage")}</LocaleLink>
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled>
            {tGrid("previousPage")}
          </Button>
        )}
        {page < totalPages ? (
          <Button asChild size="sm" variant="outline">
            <LocaleLink href={hrefFor(activeStatus, page + 1)}>{tGrid("nextPage")}</LocaleLink>
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled>
            {tGrid("nextPage")}
          </Button>
        )}
      </div>
    </div>
  );
}
