---
title: In-App Documentation Viewer
description: How the in-app Markdown docs reader sources, secures, and renders the files under docs/.
group: Reference
order: 60
---

# In-App Documentation Viewer

The application ships an **in-app documentation reader** that renders the
Markdown files under [`docs/`](.) (this very file included) inside the
authenticated shell. It is a read-only, server-rendered surface with a
sanitize-first pipeline, Mermaid + syntax highlighting, and per-document
visibility/permission gating.

> Source of truth: `src/lib/docs/**` (reader internals),
> `src/app/[locale]/(secure)/app/docs/**` (pages), and
> `src/app/api/docs/asset/[...path]/route.ts` (image assets). Follow the
> citations and read the source when in doubt.

---

## 1. Routes

| Route | Kind | Auth | Purpose |
| --- | --- | --- | --- |
| `/[locale]/app/docs` | page (secure) | session + active membership + `shell.view` | Docs landing: the grouped catalog the viewer may see. |
| `/[locale]/app/docs/[...slug]` | page (secure) | session + active membership + `shell.view` (plus the doc's own `requires`) | Renders a single document by slug. |
| `/[locale]/docs` | page (public) | none | A static public placeholder index (not the reader). |
| `/api/docs/asset/[...path]` | route handler | session + active membership + `shell.view` | Streams images referenced by a document. |

The reader lives in the **secure** tree, so the standard
`requireSecureSession` boundary (active user + active membership) applies
before any of its own checks. The slug pages and the landing additionally
require the baseline user-level `shell.view` permission, and each document
may demand more via its `requires` frontmatter (§3).

---

## 2. Where documents come from

Documents are read through a `DocumentSource` abstraction
([`src/lib/docs/source/index.server.ts`](../src/lib/docs/source/index.server.ts)).
**Phase 1 supports a single backend — the filesystem**
([`filesystem-source.server.ts`](../src/lib/docs/source/filesystem-source.server.ts)):

- The document root is `DOCS_ROOT` (defaults to the repo's `docs/`
  folder). [`safe-path.server.ts`](../src/lib/docs/safe-path.server.ts)
  canonicalizes the root and confines every slug and asset path to stay
  inside it (no traversal), restricting assets to an image allow-list.
- The **slug** and default **group** are derived from a file's path under
  the root (e.g. `docs/adr/0001-….md`).
- The full catalog is cached in-memory for **30 s**
  ([`catalog.server.ts`](../src/lib/docs/catalog.server.ts)); the cache is
  permission-independent (the unfiltered list is cached, then filtered per
  request). `clearCatalogCache()` / `clearRenderCache()` are test seams.

---

## 3. Authoring contract (frontmatter)

Each `.md` file may begin with a YAML frontmatter block. Parsing is
tolerant: **unknown keys are ignored, and invalid/missing fields fall back
to safe defaults rather than throwing**, so one malformed document never
breaks the catalog ([`frontmatter.ts`](../src/lib/docs/frontmatter.ts)).

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `title` | string | derived | When omitted, the first `#` heading in the body, else a Title-Cased slug segment. |
| `description` | string | — | One-line summary shown in the catalog. |
| `group` | string | derived from path | Sidebar grouping. |
| `order` | integer | — | Sort key within a group (ascending; ties break on title). |
| `tags` | list or comma-string | `[]` | Free-form tags. |
| `visibility` | `public` \| `internal` | `public` | `internal` docs render only when `DOCS_INTERNAL_VISIBLE` is on (§5). |
| `requires` | list or comma-string | `[]` | Permission keys; the viewer must hold **all** of them to see/open the doc. |

Example (this file's own header):

```yaml
---
title: In-App Documentation Viewer
description: How the in-app Markdown docs reader sources, secures, and renders the files under docs/.
group: Reference
order: 60
---
```

---

## 4. Access & visibility model

Two independent filters apply, both in
[`filterCatalogForViewer`](../src/lib/docs/catalog.server.ts):

1. **`visibility: internal`** docs are dropped unless `DOCS_INTERNAL_VISIBLE`
   is enabled for the environment.
2. A doc with **`requires`** is dropped unless the viewer holds **every**
   listed permission key.

These filters govern both the catalog (what appears in the sidebar/landing)
and direct slug access (`canViewDoc` returns 404-equivalent when hidden).
The **asset route** does not consult per-doc `requires`; it gates on
session + active membership + `shell.view` and returns **404 on any
failure** so it never reveals whether a file exists to an unauthorized
caller.

---

## 5. Environment variables

All optional — the defaults serve the repo's own `docs/` folder read-only.

| Var | Default | Meaning |
| --- | --- | --- |
| `DOCS_SOURCE` | `filesystem` | Document backend. Only `filesystem` is supported (Phase 1). |
| `DOCS_ROOT` | repo `docs/` | Absolute or cwd-relative document root; canonicalized and confined. |
| `DOCS_ALLOW_MDX_EXECUTION` | `false` | Gate for evaluating author JS (full MDX). **Off and ignored in Phase 1** — MDX renders as Markdown. Never safe for an untrusted source. |
| `DOCS_INTERNAL_VISIBLE` | `false` | When true, documents marked `visibility: internal` render. |

(Defined in [`src/lib/env.ts`](../src/lib/env.ts) and validated at boot.)

---

## 6. Rendering & security

The render pipeline
([`render/pipeline.server.ts`](../src/lib/docs/render/pipeline.server.ts))
is a `unified` chain built **sanitize-first** — raw HTML is never passed
through (`remarkRehype` runs with `allowDangerousHtml: false`) and
`rehype-sanitize` runs against a strict allow-list
([`sanitize-schema.ts`](../src/lib/docs/render/sanitize-schema.ts)) **before**
any enrichment:

1. `remark-parse` → `remark-gfm` → `remark-rehype` (`allowDangerousHtml: false`)
2. `rehype-sanitize` (strict schema)
3. `rehype-slug` + `rehype-autolink-headings` (heading anchors; TOC headings collected)
4. Link rewriting (locale-aware) so in-repo doc links resolve inside the viewer
5. **Mermaid**: ```` ```mermaid ```` fences become a client-mounted
   `<div class="mermaid">`, with the source kept visible as a fallback if
   its JS never runs (rendered client-side; see `_components/diagram-modal.tsx`)
6. **Syntax highlighting** via `rehype-pretty-code` + Shiki
   (`github-light` / `github-dark` themes)
7. `rehype-stringify`

No author JavaScript executes. Rendered documents are cached in-memory
(keyed per document/locale). Image assets are served only through the
hardened asset route (`nosniff` + a no-script CSP so a served SVG can never
execute; `private` caching since content is access-scoped).

---

## 7. Adding or extending docs

- **Add a doc:** drop a `.md` file under `docs/` with a frontmatter block.
  It appears in the catalog within the 30 s cache window.
- **Restrict a doc:** set `visibility: internal` (operator-gated by
  `DOCS_INTERNAL_VISIBLE`) and/or `requires: [admin.audit.read]` (the
  viewer must hold every listed key).
- **Reference an image:** place it under `docs/` and link it; it is served
  through `/api/docs/asset/...` and must match the image allow-list.
- **A new source backend** (e.g. a CMS) implements `DocumentSource`; until
  then, `DOCS_SOURCE=filesystem` is the only supported value.
