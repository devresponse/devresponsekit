---
title: "Design: secure documentation viewer"
description: Build spec for the in-app documentation viewer (the docs and help apps).
group: Design
order: 90
visibility: internal
---

# Design — Secure Documentation Viewer (`docs` app)

> **Where this file lives (review #216).** It used to sit at
> `src/app/[locale]/(secure)/app/docs/PROMPT.md`, inside the App Router route
> tree, where it was neither routable nor catalogued nor link-checked. It now
> lives under `docs/` like every other design document: `visibility: internal`
> keeps it out of the viewer unless `DOCS_INTERNAL_VISIBLE` is on, and CI's
> lychee job checks its links. `tests/unit/docs-content-hygiene.test.ts` fails
> if Markdown reappears under `src/app/`.


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
| **MDX execution** | **Never executed.** No setting enables it: `.md` and `.mdx` both render as Markdown through the sanitizing pipeline, and no author-supplied JavaScript is ever evaluated. | MDX compiles to server-side JS — executing untrusted MDX is remote code execution. Safe-by-default keeps the Phase-2 external source secure by construction. |
| **Content delivery** | **RSC (server components) only** for document text. A single narrow, path-safe route serves images. | No public content API to secure; the page reads the source server-side. |

---

## 1. Objective & scope

Phase 1 ships a working viewer over the repo's [`docs/`](./README.md)
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
MDX compiles to JavaScript that runs on the server, so the viewer never compiles it:

- **No content JS is executed.** Both `.md` and `.mdx` go through the same
  remark → rehype → **sanitize** pipeline. JSX/expression/import/export nodes are
  not evaluated (in Phase 1 they are dropped by `remark-rehype`).
- There is no switch that turns MDX evaluation on: the viewer has no MDX
  compiler. (A `DOCS_ALLOW_MDX_EXECUTION` flag was once parsed and read
  nowhere; it was removed, I-06.) Curated MDX components are a Phase-2 item and
  may only ever be enabled for the trusted filesystem source — **never** for
  the Phase-2 external source.
- Frontmatter is parsed as **YAML only** (F-86). gray-matter's built-in
  `javascript` engine, which a `---js` fence selects, runs the block through
  `eval`; `src/lib/docs/frontmatter.ts` replaces it, and the JSON and
  CoffeeScript engines, with one that refuses, so a document fenced in any
  other language is hidden (see 2d) and never evaluated.

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
- Frontmatter fails **closed** (F-87). Each field is validated on its own: a
  bad cosmetic field (`title`, `description`, `group`, `order`, `tags`) is
  dropped alone, while a bad `visibility` or `requires`, a block that cannot
  be parsed, or a file that cannot be read, hides the document from every
  viewer (even with `DOCS_INTERNAL_VISIBLE` on) until it is fixed. Each problem
  is logged as a `docs-frontmatter` warning when the catalog is built, and no
  single file can fail the catalog. An empty file is an ordinary public doc.
- One file per slug (I-18). `guide.md` and `guide.mdx` map to the same URL, so
  when both exist neither is listed or served, and a `docs-duplicate-slug`
  warning names the slug. The document page authorizes the catalog entry
  before it reads the file and the entry it read afterwards, so what renders
  is always what was authorized.
- The image route is auth-guarded and rate-limited per user
  (`DEFAULT_DOCS_ASSET_LIMIT`: a 60-request burst, then 2 per second; I-06).
  It serves any image under the space's root to every member, whichever
  document embeds it, so `requires` and `visibility` gate a document's text,
  not its images. An image must be fit for every member: the help
  walkthrough's screenshots are captured from synthetic data only, and its
  administrator-console pages carry `requires` (F-89).

---

## 3. File layout

```
src/app/[locale]/(secure)/app/docs/
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
3. `remark-rehype` (`allowDangerousHtml: false` — raw author HTML never enters;
   no footnote id prefix of its own, see step 4)
4. **`rehype-sanitize`** (hardened schema; baseline strips scripts/handlers, keeps
   `language-*` classes so the highlighter can detect languages, and prefixes
   every id with `user-content-`)
5. `rehype-slug` (heading ids, prefixed `user-content-` — trusted)
6. heading collection for `docs-toc.tsx` (depths 2–4)
7. link/image rewrite, against the document's own directory as on GitHub
   (F-90): a relative `.md` link inside the space → `/{locale}/app/{space}/...`;
   any other relative link (`../SECURITY.md`, `./openapi.json`) → plain text,
   since the viewer cannot serve it; a relative image → the asset route, or its
   alt text when it leaves the space; a `#fragment` gains the `user-content-`
   prefix; external links get `rel="noopener noreferrer"`. It runs after steps
   5 and 6, which read each heading as authored: a remote image's fallback link
   would add its alt text and URL to the id and the TOC entry.
8. `rehype-autolink-headings` (anchor links — trusted; a heading that already
   holds a link is not wrapped in a second one)
9. `rehype-pretty-code` + Shiki (server-side highlighting — trusted)
10. `rehype-stringify` → HTML string

Every id in a rendered document lives under the one `user-content-` prefix
(F-91): the article is injected into the shell's DOM, and a bare `## Navigation`
heading became a second `id="navigation"`, so its TOC entry and the shell's
skip link both jumped to the sidebar. The page injects the sanitized HTML
inside a `prose dark:prose-invert` container (Tailwind Typography).

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
  (default repo `docs/`), `HELP_ROOT` (default repo `help/`),
  `DOCS_INTERNAL_VISIBLE` (default false).
- **Build tracing** (F-88): the pages and the image routes read the content
  roots at request time, so `next.config.mjs` declares them per route
  (`outputFileTracingIncludes`: the space's `.md`/`.mdx` for the pages, its
  images for the asset route) and `getDocsRoot` names the default roots
  literally. A root built from a runtime value made the tracer ship the whole
  working tree in all six functions. CI runs `scripts/check-docs-trace.mjs`
  after `next build`: each function's trace must hold its space's content and
  nothing from `src/`, `tests/`, local artifacts or root notes. A
  `DOCS_ROOT`/`HELP_ROOT` outside the repo is not traced; it has to exist on
  the server (a mounted volume in Docker).
- **Navigation**: add a "Documentation" entry to `DEFAULT_SHELL_MENU` in
  `src/lib/navigation.server.ts` (icon `book-open`, `requiredPermissions:
  ["shell.view"]`); register the icon in `menu-icons.ts`; add the `shell`
  message key in all eight locales.
- **i18n**: new `"docs"` namespace in `en/fr/es/uk/pt/zh/hi/ja.json` for chrome (titles,
  empty/error states, "last updated", TOC heading). Document **body** content is
  not translated in Phase 1 (Phase-2 item).

---

## 8. Testing (keep the §29.2 coverage ratchet green)

- **Unit** — `safe-path` (traversal, dotfiles, bad extension, NUL all
  rejected; the `realpath` check against a symlink escape has no test yet);
  frontmatter validation; sanitize schema strips
  `<script>`/`onclick`/`javascript:` and keeps `language-*`; catalog builder +
  visibility filtering and `canViewDoc`; link/image rewrite and heading ids;
  `getVisibleDocsSections`-style filter; the image routes' session, status,
  membership and `shell.view` gates (`docs-asset-route-auth`); both slug
  pages' per-document gate (`docs-slug-pages`); every link and image rendered
  from the shipped `docs/` and `help/` lands (`docs-shipped-links`); the
  tracing config and `scripts/check-docs-trace.mjs` (`docs-trace`).
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
