import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { ApplicationShell } from "@/components/app-shell/application-shell";

/**
 * Workspace nested layout.
 *
 * Demonstrates the nested `ApplicationShell` per §17.1 — it lives inside
 * the root `ShellMain` and explicitly does NOT render a second
 * `TopShellBar`. The inner shell uses the smaller `nested` CSS variables
 * automatically via `data-variant="nested"`.
 */
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  const t = useTranslations("shell");
  return (
    <ApplicationShell ariaLabel={t("regions.workspaceShell")} left={<WorkspaceSidebar />}>
      {children}
    </ApplicationShell>
  );
}

function WorkspaceSidebar() {
  const t = useTranslations("shell");
  return (
    <nav aria-label={t("regions.workspaceNavigation")} className="p-3 text-sm">
      <ul className="flex flex-col gap-1">
        <li className="hover:bg-muted rounded-md px-2 py-1.5">{t("settings")}</li>
      </ul>
    </nav>
  );
}
