import "server-only";
import { getServerEnv } from "@/lib/env";
import { FileSystemDocumentSource } from "./filesystem-source.server";
import type { DocumentSource } from "./types";

/**
 * Selects the active {@link DocumentSource} from configuration.
 *
 * Phase 1 only knows the filesystem backend; the `DOCS_SOURCE` switch and
 * this indirection exist so Phase 2 can register an `ApiDocumentSource` /
 * `CmsDocumentSource` here without any caller changing.
 */
let cached: DocumentSource | null = null;

export function getDocumentSource(): DocumentSource {
  if (cached) return cached;
  const source = getServerEnv().DOCS_SOURCE;
  switch (source) {
    case "filesystem":
    default:
      cached = new FileSystemDocumentSource();
      return cached;
  }
}

/** Test seam: drop the memoized source. */
export function resetDocumentSource(): void {
  cached = null;
}
