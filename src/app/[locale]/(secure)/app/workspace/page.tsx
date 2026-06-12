import { useTranslations } from "next-intl";

export default function WorkspacePage() {
  const t = useTranslations("shell");
  return (
    <section className="space-y-3 p-6">
      <h1 className="text-lg font-semibold">{t("workspace")}</h1>
      <p className="text-muted-foreground text-sm">Nested shell content area.</p>
    </section>
  );
}
