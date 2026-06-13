import matter from "gray-matter";
import { z } from "zod";
import type { DocVisibility } from "./source/types";

/**
 * Frontmatter parsing + validation.
 *
 * Pure (no filesystem) so it is trivially unit-testable. `gray-matter`
 * splits the YAML block from the body; zod then coerces/validates the
 * metadata into the typed shape the catalog relies on. Unknown keys are
 * ignored. Missing/invalid fields fall back to safe defaults rather than
 * throwing, so one malformed doc never breaks the whole catalog.
 */

const visibilitySchema: z.ZodType<DocVisibility> = z.enum(["public", "internal"]);

const frontmatterSchema = z.object({
  title: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  group: z.string().trim().min(1).optional(),
  order: z.coerce.number().int().optional(),
  // Accept a YAML list or a comma-separated string.
  tags: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .transform((value) => {
      if (value === undefined) return [] as string[];
      const list = Array.isArray(value) ? value : value.split(",");
      return list.map((t) => t.trim()).filter((t) => t.length > 0);
    }),
  visibility: visibilitySchema.optional(),
  requires: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .transform((value) => {
      if (value === undefined) return [] as string[];
      const list = Array.isArray(value) ? value : value.split(",");
      return list.map((t) => t.trim()).filter((t) => t.length > 0);
    }),
});

export interface ParsedFrontmatter {
  title?: string;
  description?: string;
  group?: string;
  order?: number;
  tags: string[];
  visibility: DocVisibility;
  requires: string[];
}

export interface ParsedDocument {
  data: ParsedFrontmatter;
  /** Body with the frontmatter block removed. */
  content: string;
}

/** Parses a raw document string into validated frontmatter + body. */
export function parseFrontmatter(raw: string): ParsedDocument {
  const { data, content } = matter(raw);
  const result = frontmatterSchema.safeParse(data);
  // On invalid frontmatter, fall back to schema defaults (all fields are
  // optional, so parsing `{}` always succeeds) rather than throwing —
  // one malformed doc must never break the whole catalog.
  const parsed = result.success ? result.data : frontmatterSchema.parse({});
  return {
    data: {
      title: parsed.title,
      description: parsed.description,
      group: parsed.group,
      order: parsed.order,
      tags: parsed.tags ?? [],
      visibility: parsed.visibility ?? "public",
      requires: parsed.requires ?? [],
    },
    content,
  };
}

/**
 * Derives a human title when frontmatter omits one: the first ATX `#`
 * heading in the body, else a Title-Cased version of the slug's last
 * segment.
 */
export function deriveTitle(content: string, slug: string): string {
  const headingMatch = content.match(/^\s*#\s+(.+?)\s*$/m);
  if (headingMatch) return headingMatch[1]!.trim();
  const last = slug.split("/").pop() ?? slug;
  return last
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
