import "server-only";
import { getServerEnv } from "@/lib/env";
import { FileSystemDocumentSource } from "./filesystem-source.server";
import type { DocSpace, DocumentSource } from "./types";

/**
 * Selects the active {@link DocumentSource} for a content space from
 * configuration.
 *
 * Phase 1 only knows the filesystem backend; the `DOCS_SOURCE` switch and
 * this indirection exist so Phase 2 can register an `ApiDocumentSource` /
 * `CmsDocumentSource` here without any caller changing. Sources are
 * memoized per space so the docs and help viewers never share a root.
 */
const cached = new Map<DocSpace, DocumentSource>();

export function getDocumentSource(space: DocSpace = "docs"): DocumentSource {
  const hit = cached.get(space);
  if (hit) return hit;
  const source = getServerEnv().DOCS_SOURCE;
  switch (source) {
    case "filesystem":
    default: {
      const created = new FileSystemDocumentSource(space);
      cached.set(space, created);
      return created;
    }
  }
}

/** Test seam: drop the memoized sources. */
export function resetDocumentSource(): void {
  cached.clear();
}
