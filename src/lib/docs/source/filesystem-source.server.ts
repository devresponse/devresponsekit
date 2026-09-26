import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "@/lib/observability/logger.server";
import { getDocsRoot, resolveDocFile, DOC_EXTENSIONS } from "../safe-path.server";
import {
  deriveTitle,
  parseFrontmatter,
  unreadableDocument,
  type ParsedDocument,
} from "../frontmatter";
import type { DocCatalogEntry, DocContent, DocSpace, DocumentSource } from "./types";

/**
 * Filesystem-backed {@link DocumentSource} (Phase 1).
 *
 * Recursively scans the docs root for `*.md` / `*.mdx`, parses each
 * file's frontmatter, and derives a catalog. Slugs come from the file's
 * path relative to the root (POSIX separators, extension stripped), so
 * `guides/intro.md` → slug `guides/intro`. The grouping defaults to the
 * top-level folder (or "General" for root-level files) unless overridden
 * by frontmatter.
 *
 * All path handling defers to `safe-path.server.ts`; this module never
 * resolves a caller-supplied path itself — `getDocument` goes through
 * `resolveDocFile`, which confines the slug to the root.
 */

const DEFAULT_GROUP = "General";

function isDocFile(name: string): boolean {
  return DOC_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
}

/** Recursively lists absolute doc-file paths under `dir`, skipping dotfiles. */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // dotfiles / dotdirs
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.isFile() && isDocFile(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function slugFromRelative(relPath: string): string {
  const ext = path.extname(relPath);
  const withoutExt = ext ? relPath.slice(0, -ext.length) : relPath;
  return withoutExt.split(path.sep).join("/");
}

/**
 * Reads and parses one doc file. Never rejects: `parseFrontmatter` is built
 * not to throw, and this is the backstop for a throw it did not foresee and
 * for a file deleted or unreadable since the walk. Either would reject
 * `listCatalog`'s Promise.all and fail every page of the space, sidebar
 * included, until the file was fixed. A file that cannot be loaded is hidden
 * like one whose frontmatter cannot be read.
 */
async function loadDocument(absPath: string): Promise<ParsedDocument> {
  try {
    return parseFrontmatter(await fs.readFile(absPath, "utf8"));
  } catch (err) {
    return unreadableDocument("document could not be loaded", err);
  }
}

async function buildEntry(
  space: DocSpace,
  root: string,
  absPath: string,
): Promise<DocCatalogEntry> {
  const relPath = path.relative(root, absPath);
  const slug = slugFromRelative(relPath);
  const { data, content, issues } = await loadDocument(absPath);
  if (issues.length > 0) {
    // F-87: the catalog build is where a bad file is reported (every doc
    // page reads the catalog first); `getDocument` parses the same file to
    // the same fail-closed result without logging it again.
    logger.warn(
      { kind: "docs-frontmatter", space, slug, issues },
      "document frontmatter is invalid: bad fields are ignored, bad access fields hide the document",
    );
  }

  const segments = slug.split("/");
  const fallbackGroup = segments.length > 1 ? segments[0]! : DEFAULT_GROUP;

  let updatedAt: string | undefined;
  try {
    updatedAt = (await fs.stat(absPath)).mtime.toISOString();
  } catch {
    updatedAt = undefined;
  }

  return {
    slug,
    title: data.title ?? deriveTitle(content, slug),
    description: data.description,
    group: data.group ?? fallbackGroup,
    order: data.order ?? Number.MAX_SAFE_INTEGER,
    tags: data.tags,
    visibility: data.visibility,
    requires: data.requires,
    updatedAt,
  };
}

/**
 * I-18: `guide.md` and `guide.mdx` both map to the slug `guide`, each with its
 * own `visibility` / `requires`. The catalog used to list both, `canViewDoc`
 * authorized whichever the directory walk met first, and `getDocument`
 * rendered the one `resolveDocFile` probes first (`.md`). Two files claiming
 * one URL is an authoring error the viewer cannot settle safely, so neither
 * is listed (a doc outside the catalog 404s) and a warning names the slug.
 */
function withoutDuplicateSlugs(space: DocSpace, entries: DocCatalogEntry[]): DocCatalogEntry[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.slug)) duplicated.add(entry.slug);
    seen.add(entry.slug);
  }
  if (duplicated.size === 0) return entries;
  logger.warn(
    { kind: "docs-duplicate-slug", space, slugs: [...duplicated] },
    "more than one document file maps to the same slug: none of them is listed or served",
  );
  return entries.filter((entry) => !duplicated.has(entry.slug));
}

export class FileSystemDocumentSource implements DocumentSource {
  constructor(private readonly space: DocSpace = "docs") {}

  async listCatalog(): Promise<DocCatalogEntry[]> {
    const root = await getDocsRoot(this.space);
    const files = await walk(root);
    const entries = await Promise.all(files.map((file) => buildEntry(this.space, root, file)));
    return withoutDuplicateSlugs(this.space, entries);
  }

  async getDocument(slug: string): Promise<DocContent | null> {
    const resolved = await resolveDocFile(slug, this.space);
    if (!resolved) return null;
    const { data, content } = await loadDocument(resolved.absPath);
    const segments = resolved.slug.split("/");
    const fallbackGroup = segments.length > 1 ? segments[0]! : DEFAULT_GROUP;

    let updatedAt: string | undefined;
    try {
      updatedAt = (await fs.stat(resolved.absPath)).mtime.toISOString();
    } catch {
      updatedAt = undefined;
    }

    const entry: DocCatalogEntry = {
      slug: resolved.slug,
      title: data.title ?? deriveTitle(content, resolved.slug),
      description: data.description,
      group: data.group ?? fallbackGroup,
      order: data.order ?? Number.MAX_SAFE_INTEGER,
      tags: data.tags,
      visibility: data.visibility,
      requires: data.requires,
      updatedAt,
    };
    return { entry, body: content, format: resolved.format };
  }
}
