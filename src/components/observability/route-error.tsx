"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";

/**
 * Shared localized fallback for App Router `error.tsx` boundaries.
 *
 * Captures the render error to Sentry (a no-op when Sentry is disabled)
 * and surfaces a **Support ID** the user can quote — the Sentry event id
 * when available, otherwise Next.js's server `digest`. That id is the
 * same correlation thread carried by `x-request-id` and the audit log, so
 * support can pivot straight to the issue and the audit row.
 */
export function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("errorBoundary");
  const [supportId, setSupportId] = useState<string | null>(null);

  useEffect(() => {
    const eventId = Sentry.captureException(error);
    // One-time, display-only support id; deps are [error] so this cannot
    // loop. (The set-state-in-effect rule is a false positive here.)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupportId(eventId || error.digest || null);
  }, [error]);

  return (
    <section className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground max-w-md text-sm">{t("description")}</p>
      </div>
      {supportId ? (
        <p className="text-muted-foreground text-xs">
          {t("supportId")}: <code className="select-all">{supportId}</code>
        </p>
      ) : null}
      <Button type="button" onClick={reset}>
        {t("retry")}
      </Button>
    </section>
  );
}
