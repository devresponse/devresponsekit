"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Label } from "@/components/ui/label";

/**
 * Shared organization picker for Administrator "new" forms (ADR-0002).
 *
 * Rendered only for SUPERADMINs, who must target a specific organization
 * for an org-scoped entity:
 *   - a GROUP is always org-scoped     → `includeGlobal={false}` (a real
 *     selection is required; the placeholder option is un-selectable);
 *   - a ROLE may be Global or org-scoped → `includeGlobal` offers "Global".
 *
 * An ORG ADMIN never sees this control — the server forces their own org.
 *
 * The empty string is the wire sentinel in the native <select>: with
 * `includeGlobal` it maps to the Global (null) scope; otherwise it is the
 * un-selectable placeholder that callers validate as required.
 */
interface OrgOption {
  id: string;
  slug: string;
  name: string;
}

export function OrganizationPicker({
  value,
  onChange,
  includeGlobal = false,
  disabled = false,
  id = "organization-picker",
}: {
  value: string | null;
  onChange(next: string | null): void;
  includeGlobal?: boolean;
  disabled?: boolean;
  id?: string;
}) {
  const t = useTranslations("administrator.organizationPicker");
  const [orgs, setOrgs] = useState<OrgOption[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/administrator/organizations?pageSize=200", {
          credentials: "same-origin",
        });
        if (!res.ok) {
          if (!cancelled) setError(true);
          return;
        }
        const body = (await res.json()) as { items: OrgOption[] };
        if (!cancelled) setOrgs(body.items);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="space-y-2">
        <Label htmlFor={id}>{t("label")}</Label>
        <p className="text-destructive text-sm" role="alert">
          {t("loadError")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t("label")}</Label>
      <select
        id={id}
        className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
        value={value ?? ""}
        disabled={disabled || orgs === null}
        onChange={(e) => {
          const v = e.currentTarget.value;
          onChange(v === "" ? null : v);
        }}
      >
        {includeGlobal ? (
          <option value="">{t("global")}</option>
        ) : (
          <option value="" disabled>
            {orgs === null ? t("loading") : t("placeholder")}
          </option>
        )}
        {(orgs ?? []).map((o) => (
          <option key={o.id} value={o.id}>
            {o.name} ({o.slug})
          </option>
        ))}
      </select>
    </div>
  );
}
