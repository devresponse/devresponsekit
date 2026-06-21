# PROMPT — Secure Documentation Viewer (`docs` app)

> Build spec for an in-app, **secure** documentation viewer that reads a
> catalog of `.md` / `.mdx` files from a configurable filesystem root and
> renders them to **safe** HTML inside the existing secure shell. Designed
> so the file source can be swapped for an external API / CMS in Phase 2
> without touching the UI or rendering layers.

This document is both the design and the executable plan. It mirrors the
conventions already used by the `account` and `administrator` sub-apps so a
junior developer can follow it end-to-end.

---

## 0. Baked-in decisions

These were chosen up front; the rest of the spec assumes them.

| Decision | Choice | Why |
| --- | --- | --- |
| **Access gate** | Baseline **`shell.view`** (user-level, no `admin.*`). | Docs are for every active member, same posture as the Account app. Per-doc `visibility` can tighten this later. |
| **MDX execution** | **OFF by default.** Content is rendered through a sanitizing Markdown pipeline; no author-supplied JavaScript is ever evaluated. | MDX compiles to server-side JS — executing untrusted MDX is remote code execution. Safe-by-default keeps the Phase-2 external source secure by construction. |
| **Content delivery** | **RSC (server components) only** for document text. A single narrow, path-safe route serves images. | No public content API to secure; the page reads the source server-side. |

---

## 1. Objective & scope

Phase 1 ships a working viewer over the repo's [`docs/`](../../../../../../docs)
folder:

- A **catalog** sidebar (grouped, collapsible) built by scanning a configured
  root for `.md` / `.mdx` files and parsing their frontmatter.
- A **document page** that renders Markdown → sanitized HTML with GitHub-flavored
  Markdown, server-side syntax highlighting, heading anchors, and a right-rail
  **table of contents**.
- The whole app lives behind the secure shell and is gated on `shell.view`.

Phase 2 swaps the filesystem source for an external API/CMS behind the **same
interface** — UI, catalog, and rendering layers stay untouched.

---

## 2. Security model (the core)

A docs viewer has three distinct threats. All three are addressed:

### 2a. Path traversal (filesystem)
The document slug comes from the URL (`[...slug]`) and is therefore **untrusted
input that becomes a file path**. One audited choke point, `resolveDocPath`,
defends it:

1. Read the root once from config (`DOCS_ROOT`, default the repo `docs/`),
   resolve to an absolute **real path** (`fs.realpath`).
2. Reject any slug segment containing `..`, path separators, NUL bytes, a leading
   dot (dotfiles), or whose extension is not in the allow-list (`.md`, `.mdx`).
3. Join → `path.resolve` → `fs.realpath` the candidate → assert the canonical
   result is still **inside** the root real path (prefix check, so symlinks that
   escape the root are caught).
4. Any failure → `notFound()`. Never echo the attempted path back.

### 2b. Code execution (MDX)
MDX compiles to JavaScript that runs on the server. Default posture:

- **No content JS is executed.** Both `.md` and `.mdx` go through the same
  remark → rehype → **sanitize** pipeline. JSX/expression/import/export nodes are
  not evaluated (in Phase 1 they are dropped by `remark-rehype`).
- Full MDX evaluation stays **off** behind `DOCS_ALLOW_MDX_EXECUTION` and may
  only ever be enabled for the trusted filesystem source — **never** for the
  Phase-2 external source.

### 2c. XSS (rendered HTML)
Server-render only; no client-side eval. The pipeline **sanitizes untrusted
content first, then applies trusted transforms** (heading slugs, anchor links,
syntax highlighting). Because sanitize runs before the highlighter, the only
inline styles in the output come from the trusted Shiki theme, not from author
input. `<script>` / `<style>` / event handlers / `javascript:` URLs are stripped.

### 2d. Access control
- Whole app gated on `shell.view` via `requireSecureSession` (same as Account).
- Optional per-document `visibility` (`public` | `internal`) and `requires`
  (permission keys) in frontmatter. The catalog filters documents the caller may
  not see **before** they reach the sidebar or a route — a hidden doc is
  `notFound()`, not merely unlinked.
- The image route is auth-guarded and rate-limited.

---

## 3. File layout

```
src/app/[locale]/(secure)/app/docs/
├── PROMPT.md                       # this file
├── layout.tsx                      # nested ApplicationShell, requireSecureSession (shell.view)
├── page.tsx                        # catalog landing / index
├── [...slug]/page.tsx              # render one document
└── _components/
    ├── docs-sidebar.tsx            # catalog tree (client; grouped, collapsible)
    ├── docs-top-header.tsx         # header + sidebar toggle
    ├── docs-breadcrumbs.tsx        # path breadcrumbs (NOT a back-link)
    ├── docs-toc.tsx                # right-rail table of contents
    └── doc-article.tsx             # renders sanitized HTML in a prose container

src/lib/docs/
├── source/
│   ├── types.ts                    # DocumentSource interface (the Phase-2 seam)
│   ├── filesystem-source.server.ts # Phase 1 implementation
│   └── index.server.ts             # selects source from DOCS_SOURCE
├── safe-path.server.ts             # traversal-proof slug → absolute path
├── frontmatter.ts                  # typed frontmatter parse/validate (zod)
├── catalog.server.ts               # build + cache the catalog tree
└── render/
    ├── sanitize-schema.ts          # hardened rehype-sanitize allow-list
    └── pipeline.server.ts          # md/mdx → sanitized HTML + heading list

src/app/api/docs/asset/[...path]/route.ts   # path-safe, auth-guarded image server
```

The route tree only ever talks to `src/lib/docs`; `src/lib/docs` only ever talks
to the `DocumentSource` interface. `fs` is touched solely by the filesystem
source and the safe-path resolver.

---

## 4. The source seam (Phase-2 flexibility)

```ts
// src/lib/docs/source/types.ts
export interface DocCatalogEntry {
  slug: string;                 // url path segment(s): "setup-better-auth"
  title: string;
  description?: string;
  group?: string;               // sidebar grouping (folder by default)
  order?: number;
  tags?: string[];
  visibility: "public" | "internal";
  requires?: string[];          // permission keys (AND)
  updatedAt?: string;           // ISO
}
export interface DocContent {
  entry: DocCatalogEntry;
  body: string;                 // raw md/mdx
  format: "md" | "mdx";
}
export interface DocumentSource {
  listCatalog(): Promise<DocCatalogEntry[]>;
  getDocument(slug: string): Promise<DocContent | null>;
}
```

- **Phase 1** — `FileSystemDocumentSource`: scans `DOCS_ROOT` for `*.md` / `*.mdx`,
  parses frontmatter, derives `slug` from the relative path, groups by folder.
- **Phase 2** — `ApiDocumentSource` / `CmsDocumentSource` implement the same
  interface; selected via `DOCS_SOURCE`. Nothing else changes.

---

## 5. Render pipeline

`unified` chain (all server-side), ordered so untrusted content is sanitized
**before** trusted transforms:

1. `remark-parse`
2. `remark-gfm`
3. `remark-rehype` (`allowDangerousHtml: false` — raw author HTML never enters)
4. **`rehype-sanitize`** (hardened schema; baseline strips scripts/handlers, keeps
   `language-*` classes so the highlighter can detect languages)
5. `rehype-slug` (heading ids — trusted)
6. `rehype-autolink-headings` (anchor links — trusted)
7. link/image rewrite (relative `.md` links → `/{locale}/app/docs/...`; relative
   image `src` → the asset route; external links get `rel="noopener noreferrer"`)
8. `rehype-pretty-code` + Shiki (server-side highlighting — trusted)
9. `rehype-stringify` → HTML string

Headings collected during the pass feed `docs-toc.tsx`. The page injects the
sanitized HTML inside a `prose dark:prose-invert` container (Tailwind Typography).

`.mdx` files run through the **same** pipeline in Phase 1; JSX/expression nodes
are dropped (no execution). Curated MDX-component rendering is a Phase-2 item.

---

## 6. UI & shell (mirror the `account` app)

- **`layout.tsx`** — copy `account/layout.tsx`: `SidebarProvider`
  (`cookieName="docs_sidebar_state"`, `keyboardShortcut={null}`) wrapping
  `ApplicationShell` (`layout="sidebar-first"`), guarded by
  `requireSecureSession(locale, "/{locale}/app/docs")`. `export const dynamic = "force-dynamic"`.
- **`docs-sidebar.tsx`** — `"use client"`, `FlexSidebar collapsible="icon"`,
  renders the catalog grouped by `group`, active item from `usePathname()`, icons
  via `getMenuIcon` (allow-list). Built from the catalog passed by the layout.
- **`docs-top-header.tsx`** — minimal: `SidebarTrigger` + app title (copy
  `account-top-header.tsx`).
- **`page.tsx`** (index) — catalog landing: groups → cards/links. Read-only.
- **`[...slug]/page.tsx`** — resolve slug → `getDocument` → render via
  `doc-article.tsx`; 404 via `notFound()` on miss; breadcrumbs + TOC.
- **No forms** in this app, so the "no BACK link at top of a form" rule is moot;
  breadcrumbs (not a back-link) provide navigation.

---

## 7. Wiring

- **Dependencies** (none present today): `unified`, `remark-parse`, `remark-gfm`,
  `remark-rehype`, `rehype-slug`, `rehype-autolink-headings`, `rehype-sanitize`,
  `rehype-pretty-code`, `shiki`, `rehype-stringify`, `gray-matter`, and
  `@tailwindcss/typography` (added via `@plugin` in `globals.css`). `zod` (already
  present) validates frontmatter.
- **Env** (`src/lib/env.ts`): `DOCS_SOURCE` (`filesystem` default), `DOCS_ROOT`
  (default repo `docs/`), `DOCS_ALLOW_MDX_EXECUTION` (default false),
  `DOCS_INTERNAL_VISIBLE` (default false).
- **Navigation**: add a "Documentation" entry to `DEFAULT_SHELL_MENU` in
  `src/lib/navigation.server.ts` (icon `book-open`, `requiredPermissions:
  ["shell.view"]`); register the icon in `menu-icons.ts`; add the `shell`
  message key in all six locales.
- **i18n**: new `"docs"` namespace in `en/fr/es/uk/pt/zh.json` for chrome (titles,
  empty/error states, "last updated", TOC heading). Document **body** content is
  not translated in Phase 1 (Phase-2 item).

---

## 8. Testing (keep the §29.2 coverage ratchet green)

- **Unit** — `safe-path` (traversal, symlink-escape, dotfiles, bad extension, NUL
  all rejected); frontmatter validation; sanitize schema strips
  `<script>`/`onclick`/`javascript:` and keeps `language-*`; catalog builder +
  visibility filtering; link/image rewrite; `getVisibleDocsSections`-style filter.
- **Integration** — render pipeline over a fixture doc (headings, code block,
  links); traversal slug → null/notFound.
- **e2e + a11y (Playwright)** — open docs, navigate the tree, render a doc, TOC
  anchors resolve, prose page passes the a11y sweep (CI "browser" job).

---

## 9. Phasing

- **Phase 1 (this build)** — filesystem source, MD render (+ `.mdx` as Markdown),
  catalog sidebar, TOC, highlighting, image route, nav + i18n + env, tests, gates.
- **Phase 1.5** — search (client filter over catalog → prebuilt index if needed).
- **Phase 2** — `ApiDocumentSource`/`CmsDocumentSource` behind the same interface;
  cache invalidation (webhook/TTL); curated MDX components (gated, trusted source
  only); optional body i18n; optional editing/preview.
