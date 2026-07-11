import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { getServerEnv } from "@/lib/env";
import type { DocSpace } from "./source/types";

/**
 * Path-safety boundary for the documentation viewer.
 *
 * The document slug arrives from the URL (`[...slug]`) and is therefore
 * UNTRUSTED input that gets turned into a filesystem path. Every read in
 * the docs app funnels through here so there is exactly one audited
 * choke point against traversal, absolute-path injection, dotfile
 * access, and symlink escapes.
 *
 * The pure helpers (`splitSlug`, `isSafeSegment`, `isPathInsideRoot`) are
 * exported so they can be unit-tested without a filesystem; the
 * fs-touching resolvers build on them.
 */

/** Document file extensions the viewer will serve. */
export const DOC_EXTENSIONS = [".md", ".mdx"] as const;

/**
 * Image extensions the asset route may serve, mapped to their MIME type.
 * Anything not listed here is rejected — the viewer never streams
 * arbitrary file types out of the docs root.
 */
export const IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

/**
 * Matches any C0/C1 control character (incl. NUL) — never valid in a file
 * name. Built from an escaped string so the source stays pure ASCII (no
 * literal control bytes, hence no `no-control-regex` lint suppression).
 */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]");

/**
 * A single path segment is safe when it is a plain file/dir name: no
 * separators, no `.`/`..`, no leading dot (dotfiles), no NUL or control
 * characters, and non-empty.
 */
export function isSafeSegment(segment: string): boolean {
  if (segment.length === 0) return false;
  if (segment === "." || segment === "..") return false;
  if (segment.startsWith(".")) return false; // dotfiles / dotdirs
  // Path separators or drive markers must never appear inside a segment.
  if (segment.includes("/") || segment.includes("\\")) return false;
  if (segment.includes(":")) return false;
  if (CONTROL_CHARS.test(segment)) return false;
  return true;
}

/**
 * Splits a slug (string or already-split array) into clean segments and
 * returns `null` if any segment is unsafe. URL-encoded input is decoded
 * first so `%2e%2e` style traversal is caught.
 */
export function splitSlug(slug: string | string[]): string[] | null {
  const raw = Array.isArray(slug) ? slug : slug.split("/");
  const segments: string[] = [];
  for (const part of raw) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return null; // malformed percent-encoding
    }
    if (decoded === "") continue; // tolerate leading/trailing/double slashes
    if (!isSafeSegment(decoded)) return null;
    segments.push(decoded);
  }
  return segments.length > 0 ? segments : null;
}

/**
 * True when `candidate` resolves to a location at or below `root`. Both
 * inputs must be absolute. Uses `path.relative` so it is correct across
 * platforms and catches `..` escapes regardless of separator style.
 */
export function isPathInsideRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === "") return true; // candidate === root
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

const cachedRoots = new Map<DocSpace, string>();

/**
 * Resolves and caches the canonical (symlink-free) absolute content root
 * for a space. The docs space defaults to `<cwd>/docs` when `DOCS_ROOT`
 * is unset; the help space defaults to `<cwd>/help` when `HELP_ROOT` is
 * unset.
 */
export async function getDocsRoot(space: DocSpace = "docs"): Promise<string> {
  const cached = cachedRoots.get(space);
  if (cached) return cached;
  const env = getServerEnv();
  const configured = space === "help" ? env.HELP_ROOT : env.DOCS_ROOT;
  const base = configured ? path.resolve(configured) : path.resolve(process.cwd(), space);
  const root = await fs.realpath(base);
  cachedRoots.set(space, root);
  return root;
}

/** Test seam: forget the cached roots so a new `DOCS_ROOT`/`HELP_ROOT` takes effect. */
export function resetDocsRootCache(): void {
  cachedRoots.clear();
}

/**
 * Canonicalizes `absPath` and asserts it stays inside `root`. Returns the
 * real path on success or `null` if it does not exist or escapes the root
 * (e.g. via a symlink pointing outside). Never throws on a miss.
 */
async function realpathInside(root: string, absPath: string): Promise<string | null> {
  let real: string;
  try {
    real = await fs.realpath(absPath);
  } catch {
    return null;
  }
  return isPathInsideRoot(root, real) ? real : null;
}

/** A resolved document file. */
export interface ResolvedDoc {
  absPath: string;
  slug: string;
  format: "md" | "mdx";
}

/**
 * Resolves a document slug to a real file inside the docs root, probing
 * the `.md` then `.mdx` extension. Returns `null` for unsafe slugs or
 * misses — callers map that to `notFound()`.
 */
export async function resolveDocFile(
  slug: string | string[],
  space: DocSpace = "docs",
): Promise<ResolvedDoc | null> {
  const segments = splitSlug(slug);
  if (!segments) return null;
  const root = await getDocsRoot(space);
  const relBase = segments.join(path.sep);

  for (const ext of DOC_EXTENSIONS) {
    const candidate = path.resolve(root, relBase + ext);
    // Cheap structural check before hitting the filesystem.
    if (!isPathInsideRoot(root, candidate)) continue;
    const real = await realpathInside(root, candidate);
    if (real) {
      return { absPath: real, slug: segments.join("/"), format: ext === ".mdx" ? "mdx" : "md" };
    }
  }
  return null;
}

/** A resolved asset (image) file. */
export interface ResolvedAsset {
  absPath: string;
  contentType: string;
}

/**
 * Resolves an asset path (with its real extension included) to a real
 * file inside the docs root, restricted to the image allow-list. Returns
 * `null` for unsafe paths, disallowed extensions, or misses.
 */
export async function resolveAssetFile(
  slug: string | string[],
  space: DocSpace = "docs",
): Promise<ResolvedAsset | null> {
  const segments = splitSlug(slug);
  if (!segments) return null;
  const last = segments[segments.length - 1]!;
  const ext = path.extname(last).toLowerCase();
  const contentType = IMAGE_CONTENT_TYPES[ext];
  if (!contentType) return null;

  const root = await getDocsRoot(space);
  const candidate = path.resolve(root, segments.join(path.sep));
  if (!isPathInsideRoot(root, candidate)) return null;
  const real = await realpathInside(root, candidate);
  if (!real) return null;
  return { absPath: real, contentType };
}
