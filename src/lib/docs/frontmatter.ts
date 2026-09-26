import matter from "gray-matter";
import { z } from "zod";
import type { DocVisibility } from "./source/types";

/**
 * Frontmatter parsing + validation.
 *
 * Pure (no filesystem, no logger) so it is trivially unit-testable.
 * `gray-matter` splits the YAML block from the body; zod then
 * coerces/validates the metadata into the typed shape the catalog relies
 * on. Unknown keys are ignored. It never throws: one malformed doc must
 * never break the whole catalog. Every problem is returned in `issues` for
 * the caller to log.
 *
 * Only YAML is ever parsed (F-86). gray-matter 4 picks the parser from the
 * text after the opening fence, and its built-in `javascript` engine (which
 * `---js` aliases to) runs the block through `eval`, on the server, with
 * the whole process environment in reach. {@link MATTER_OPTIONS} replaces
 * every non-YAML engine gray-matter knows with one that refuses, so only
 * js-yaml's `safeLoad` ever sees a block, and any other fence language
 * fails closed below.
 *
 * Fields are validated one at a time (F-87). A bad cosmetic field (`title`,
 * `description`, `group`, `order`, `tags`) is dropped on its own. A bad
 * ACCESS field (`visibility`, `requires`), or a block that cannot be read
 * at all, fails CLOSED: the doc is hidden from every viewer until it is
 * fixed. Validating the block as a whole used to fall back to the defaults
 * on any error, so a fractional `order` next to `visibility: internal` made
 * an internal doc public.
 */

const visibilitySchema: z.ZodType<DocVisibility> = z.enum(["public", "internal"]);

const nonEmptyText = z.string().trim().min(1);

// Accept a YAML list or a comma-separated string.
const keyList = z.union([z.array(z.string()), z.string()]).transform((value) => {
  const list = Array.isArray(value) ? value : value.split(",");
  return list.map((t) => t.trim()).filter((t) => t.length > 0);
});

const orderSchema = z.coerce.number().int();

/**
 * F-87: the `requires` key a doc gets when its access metadata cannot be
 * trusted. No viewer can hold it: a permission key must match
 * `PERMISSION_KEY_RE` (src/lib/validation/permissions.ts), which admits no
 * space or parenthesis. So `filterCatalogForViewer` hides the doc from
 * everyone, even when `DOCS_INTERNAL_VISIBLE` shows internal docs.
 */
export const UNSATISFIABLE_REQUIREMENT = "(invalid frontmatter)";

function refuseEngine(): never {
  throw new Error("only YAML frontmatter is accepted");
}

/**
 * F-86: gray-matter merges these over its defaults. `javascript` covers
 * `---js` and `---javascript` in any case (gray-matter aliases both to it);
 * `json` and `coffee` go too, so the rule is simply "YAML only". A fence
 * naming anything else is refused by gray-matter itself ("engine not
 * registered"). Passing options also turns off gray-matter's unbounded
 * module-level cache of every parsed document, whose hits would lose the
 * non-enumerable `language` the check below reads.
 */
const MATTER_OPTIONS = {
  engines: { javascript: refuseEngine, json: refuseEngine, coffee: refuseEngine },
};

const YAML_LANGUAGES = new Set(["yaml", "yml"]);

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
  /** What was wrong with the frontmatter, for the caller to log. Empty when clean. */
  issues: string[];
}

/** The access metadata of a doc whose frontmatter cannot be trusted: nobody sees it (F-87). */
function hidden(): Pick<ParsedFrontmatter, "visibility" | "requires"> {
  return { visibility: "internal", requires: [UNSATISFIABLE_REQUIREMENT] };
}

function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n")[0]!.trim();
}

/**
 * The result for a document none of whose metadata can be read (`what`
 * failed with `err`): no fields, no body, hidden from every viewer (F-87).
 */
export function unreadableDocument(what: string, err: unknown): ParsedDocument {
  return {
    data: { tags: [], ...hidden() },
    content: "",
    issues: [`${what}: ${firstLine(err)}; document hidden`],
  };
}

function isMapping(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Parses a raw document string into validated frontmatter + body. Never throws. */
export function parseFrontmatter(raw: string): ParsedDocument {
  let file: matter.GrayMatterFile<string>;
  try {
    file = matter(raw, MATTER_OPTIONS);
  } catch (err) {
    // A YAML syntax error, a refused engine, js-yaml's merge-size guard: the
    // block may have gated the doc, and nothing in it can be read.
    return unreadableDocument("frontmatter could not be parsed", err);
  }

  // gray-matter's typings say `language` is always set, but its early return
  // for an empty string (a 0-byte file) leaves it out. No block means the
  // default, YAML, as for any other file without one.
  const language = (file.language as string | undefined) ?? "yaml";
  const issues: string[] = [];
  let data: Record<string, unknown> = {};
  let unreadable = false;
  if (!YAML_LANGUAGES.has(language.toLowerCase())) {
    // A fence gray-matter did not refuse: an Object.prototype member such as
    // `---constructor`, which its engine lookup finds on the plain object
    // that holds the engines.
    issues.push(`frontmatter language "${language}" is not YAML`);
    unreadable = true;
  } else if (!isMapping(file.data)) {
    issues.push("frontmatter is not a key/value mapping");
    unreadable = true;
  } else {
    data = file.data;
  }

  const invalid = new Set<string>();
  function field<T>(key: string, schema: z.ZodType<T>): T | undefined {
    const value = data[key];
    if (value === undefined) return undefined;
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    invalid.add(key);
    issues.push(`${key}: invalid value ignored`);
    return undefined;
  }

  const cosmetic = {
    title: field("title", nonEmptyText),
    description: field("description", nonEmptyText),
    group: field("group", nonEmptyText),
    order: field("order", orderSchema),
    tags: field("tags", keyList) ?? [],
  };
  const visibility = field("visibility", visibilitySchema);
  const requires = field("requires", keyList);

  if (unreadable || invalid.has("visibility") || invalid.has("requires")) {
    issues.push("access metadata cannot be trusted; document hidden");
    return {
      data: { ...cosmetic, ...hidden() },
      content: file.content,
      issues,
    };
  }
  return {
    // An ABSENT access field keeps the documented default: public, no gate.
    data: { ...cosmetic, visibility: visibility ?? "public", requires: requires ?? [] },
    content: file.content,
    issues,
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
