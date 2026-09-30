import { z } from "zod";

/** The most ids either side of a dual-list PATCH may name, as its POST/DELETE twins allow. */
export const DUAL_LIST_PATCH_MAX = 500;

/**
 * F-38: the body of the atomic dual-list saves, `PATCH /roles/[id]/permissions`
 * (permission keys) and `PATCH /groups/[id]/roles` (role ids):
 * `{ add?: item[], remove?: item[] }`.
 *
 * Duplicates are dropped, so each side is a set. The body must name at least
 * one item, and an item on both sides is refused, because "add and remove it"
 * has no single outcome to apply atomically. Both are `invalid_body` (400).
 */
export function dualListPatchSchema(item: z.ZodType<string>) {
  const side = z.array(item).max(DUAL_LIST_PATCH_MAX).optional();
  return z
    .object({ add: side, remove: side })
    .strict()
    .transform(({ add = [], remove = [] }) => ({
      add: [...new Set(add)],
      remove: [...new Set(remove)],
    }))
    .refine((body) => body.add.length + body.remove.length > 0, "empty")
    .refine((body) => !body.add.some((id) => body.remove.includes(id)), "overlap");
}
