/**
 * Document source contract — the seam that lets Phase 2 swap the
 * filesystem backend for an external API / CMS without touching the
 * catalog, renderer, or UI layers.
 *
 * Every implementation returns the SAME shapes; the route tree and the
 * rendering pipeline only ever depend on this interface.
 */

/**
 * Content space served by the viewer machinery. Each space has its own
 * content root, catalog cache, app route base (`/app/<space>`), and asset
 * route (`/api/<space>/asset`). "docs" is the original documentation
 * viewer; "help" is its identical sibling serving the walkthrough.
 */
export type DocSpace = "docs" | "help";

/** Visibility of a document to the viewer audience. */
export type DocVisibility = "public" | "internal";

/** Source format of a document file. */
export type DocFormat = "md" | "mdx";

/**
 * A single catalog entry — enough to render the sidebar/landing without
 * reading the document body.
 */
export interface DocCatalogEntry {
  /** URL path (locale-less, no extension), e.g. `"setup-better-auth"`. */
  slug: string;
  title: string;
  description?: string;
  /** Sidebar grouping; defaults to the top-level folder or "General". */
  group: string;
  /** Sort key within a group (ascending); ties break on title. */
  order: number;
  tags: string[];
  visibility: DocVisibility;
  /** Permission keys the caller must ALL hold to see the document. */
  requires: string[];
  /** ISO timestamp of last modification, when the source can provide it. */
  updatedAt?: string;
}

/** A document's catalog metadata plus its raw, unrendered body. */
export interface DocContent {
  entry: DocCatalogEntry;
  /** Raw Markdown / MDX with frontmatter already stripped. */
  body: string;
  format: DocFormat;
}

export interface DocumentSource {
  /** Lists every document the source knows about (unfiltered). */
  listCatalog(): Promise<DocCatalogEntry[]>;
  /** Loads one document by slug, or `null` if it does not exist. */
  getDocument(slug: string): Promise<DocContent | null>;
}
