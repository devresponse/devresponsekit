"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { LayoutGrid } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { AppSwitcherSkeleton } from "@/components/app-shell/navigation-menu-skeleton";
import {
  fetchApplicationsMenu,
  NavigationApiError,
} from "@/components/navigation/navigation-api-client";
import type { EnterpriseApplicationMenuItem } from "@/components/navigation/menu-types";

export interface ApplicationSwitcherSheetProps {
  locale: string;
}

/**
 * ApplicationSwitcherSheet
 *
 * Lives in the `TopShellBar` and triggers a sheet that loads
 * `/api/navigation/applications` lazily on open. Items render as plain
 * anchors pointing at `/api/sso/launch?...` so the browser performs the
 * cross-subdomain redirect through the secure handoff route — the client
 * never receives a long-lived token.
 *
 * Loading and failure states use the skeleton + retry pattern required
 * by §25.
 */
export function ApplicationSwitcherSheet({ locale }: ApplicationSwitcherSheetProps) {
  const t = useTranslations("shell");
  const tCommon = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<EnterpriseApplicationMenuItem[] | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setErrorStatus(null);

    fetchApplicationsMenu(locale)
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof NavigationApiError) {
          setErrorStatus(error.status);
        } else {
          setErrorStatus(500);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, locale, reloadKey]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button type="button" variant="outline" size="sm" aria-label={t("switchApplication")}>
          <LayoutGrid className="mr-2 h-4 w-4" aria-hidden="true" />
          {t("applications")}
        </Button>
      </SheetTrigger>

      <SheetContent side="right" closeLabel={tCommon("closeMenu")}>
        <SheetHeader>
          <SheetTitle>{t("switchApplication")}</SheetTitle>
          <SheetDescription>{t("applications")}</SheetDescription>
        </SheetHeader>

        {loading || items === null ? (
          errorStatus ? (
            <div className="space-y-2">
              <p className="text-sm text-red-700">
                {errorStatus === 401 || errorStatus === 403
                  ? t("unauthorized")
                  : tCommon("unexpectedError")}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setReloadKey((k) => k + 1)}
              >
                {tCommon("retry")}
              </Button>
            </div>
          ) : (
            <AppSwitcherSkeleton />
          )
        ) : items.length === 0 ? (
          <p className="text-sm text-neutral-600">{t("noApplications")}</p>
        ) : (
          <ul className="flex flex-col gap-1" role="list">
            {items.map((item) => (
              <li key={item.id}>
                {/*
                  Plain <a> on purpose: SSO launch is an API route. Using
                  next-intl Link would prepend a locale and break the
                  signed redirect.
                */}
                <a
                  href={item.ssoLaunchUrl}
                  className="hover:bg-shell-muted focus-visible:ring-shell-accent block rounded-md p-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
                  data-status={item.status}
                  rel="nofollow noreferrer"
                >
                  <span className="font-medium">{item.label}</span>
                  {item.description ? (
                    <span className="block text-xs text-neutral-600">{item.description}</span>
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
        )}
      </SheetContent>
    </Sheet>
  );
}
