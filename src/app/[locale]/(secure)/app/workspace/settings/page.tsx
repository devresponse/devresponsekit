import { useTranslations } from "next-intl";

/**
 * WorkspaceSettingsPage
 *
 * Secure workspace-level settings page at `/[locale]/app/workspace/settings`.
 * Rendered inside the workspace `ApplicationShell`; does not add a second
 * secure session check (the parent `(secure)/layout.tsx` already guards it).
 *
 * Content is intentionally minimal — detailed settings panels are out of
 * scope for this scaffold.
 */
export default function WorkspaceSettingsPage() {
  const t = useTranslations("shell");
  return (
    <section className="space-y-4 p-6">
      <h1 className="text-xl font-semibold">{t("settings")}</h1>
      <p className="text-sm text-neutral-600">
        Workspace configuration options will appear here.
      </p>
    </section>
  );
}
