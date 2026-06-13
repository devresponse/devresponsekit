import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { getDocsRoot, resolveDocFile, DOC_EXTENSIONS } from "../safe-path.server";
import { deriveTitle, parseFrontmatter } from "../frontmatter";
import type { DocCatalogEntry, DocContent, DocumentSource } from "./types";

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

async function buildEntry(root: string, absPath: string): Promise<DocCatalogEntry> {
  const relPath = path.relative(root, absPath);
  const slug = slugFromRelative(relPath);
  const raw = await fs.readFile(absPath, "utf8");
  const { data, content } = parseFrontmatter(raw);

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

export class FileSystemDocumentSource implements DocumentSource {
  async listCatalog(): Promise<DocCatalogEntry[]> {
    const root = await getDocsRoot();
    const files = await walk(root);
    const entries = await Promise.all(files.map((file) => buildEntry(root, file)));
    return entries;
  }

  async getDocument(slug: string): Promise<DocContent | null> {
    const resolved = await resolveDocFile(slug);
    if (!resolved) return null;
    const raw = await fs.readFile(resolved.absPath, "utf8");
    const { data, content } = parseFrontmatter(raw);
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
