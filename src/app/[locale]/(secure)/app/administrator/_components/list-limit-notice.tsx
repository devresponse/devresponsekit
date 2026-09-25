import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/**
 * "Showing N of M" under a picker or catalog that holds fewer rows than the
 * endpoint's `total` (F-41). Renders nothing when every row is on screen.
 *
 *   - `search`: a picker's server search matched more rows than one answer
 *     carries, so typing more narrows it.
 *   - `catalog`: `fetchAllPages` stopped short (its cap, or a count that kept
 *     changing on every re-read), so some rows are not listed at all. A
 *     change it could not detect (an insert and a delete between the same
 *     two page reads) shows no notice: see `fetchAllPages`.
 *
 * Deliberately not a live region: it sits next to the pickers' and editors'
 * own `status` / `alert` messages and must not compete with them.
 */
export function ListLimitNotice({
  shown,
  total,
  kind,
  className,
}: {
  shown: number;
  total: number;
  kind: "search" | "catalog";
  className?: string;
}) {
  const t = useTranslations("administrator.listLimit");
  if (total <= shown) return null;
  return (
    <p className={cn("text-muted-foreground text-xs", className)} data-list-limit={kind}>
      {t(kind === "search" ? "searchTruncated" : "catalogTruncated", { shown, total })}
    </p>
  );
}
