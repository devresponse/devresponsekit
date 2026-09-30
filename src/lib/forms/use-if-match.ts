"use client";

import { useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * F-39: optimistic concurrency for a Settings form whose record the server
 * versions with an ETag: the organization, role and group Settings tabs
 * (`src/lib/admin/record-etag.server.ts`).
 *
 * The detail page hands the form the record's tag (`serverEtag`, computed from
 * the row it renders), and the form sends it as `If-Match` on its PATCH
 * (`headers()`). The route answers 412 `precondition_failed` when the record
 * was saved since the form read it, by another admin or by the same admin in
 * another browser tab. Before, the later save silently overwrote the earlier
 * one's fields.
 *
 *   - `adopt(res)` after a successful save takes the tag the PATCH answered,
 *     so the form's next save is not refused because of its own last one when
 *     it is sent before the page refresh lands.
 *   - The tag FOLLOWS `serverEtag` whenever the page's props change: the
 *     refresh after a save, or `reload()` after a conflict.
 *   - `reload()` after a 412 refreshes the page. `useSavedFormBaseline` then
 *     moves the form's baseline to the record as the other save left it and
 *     keeps the fields this admin edited, so the next save sends only those,
 *     against the current tag. The form names the conflict meanwhile.
 */
export function useIfMatch(serverEtag: string) {
  const router = useRouter();
  const tag = useRef(serverEtag);
  useEffect(() => {
    tag.current = serverEtag;
  }, [serverEtag]);

  return useMemo(
    () => ({
      headers(): Record<string, string> {
        return { "if-match": tag.current };
      },
      adopt(res: Response): void {
        const next = res.headers.get("etag");
        if (next) tag.current = next;
      },
      reload(): void {
        router.refresh();
      },
    }),
    [router],
  );
}
