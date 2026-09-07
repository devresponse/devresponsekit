import { defaultSchema } from "rehype-sanitize";

/**
 * Hardened sanitize schema for the docs pipeline.
 *
 * `defaultSchema` (GitHub's profile) already strips `<script>`/`<style>`,
 * event-handler attributes, and dangerous URL protocols, and it ALREADY
 * allows the one class name our pipeline depends on:
 *
 *   `code: [["className", /^language-./]]`
 *
 * which is what carries the ```lang fence hint into rehype-pretty-code and
 * lets `rehypeMermaid` spot a `language-mermaid` block.
 *
 * Review #214: this file used to append a bare `"className"` to `code`,
 * `pre`, and `span`. A bare string in hast-util-sanitize means "any value",
 * so that entry did not *add* the language hint (it was already there) — it
 * WIDENED it, letting authored Markdown put an arbitrary class on those
 * elements (`pre`/`span` gained one they never had). Nothing in the pipeline
 * needs that: authored Markdown only ever produces `code.language-*`, and the
 * `pre`/`span`/`div` classes in the output are added AFTER sanitize by our own
 * trusted transforms (Shiki, the anchor wrapper, the Mermaid mount). So we
 * narrow back to the default and only tighten from there.
 *
 * The one deliberate deviation from `defaultSchema` is `protocols.src`:
 * defaults allow `http` and `https`, but a plain-`http` subresource is
 * upgraded/blocked in production anyway (`upgrade-insecure-requests`), so we
 * drop it (review #215). Remote images are additionally replaced by a visible
 * fallback in the pipeline — the app's `img-src 'self' data: blob:` CSP would
 * otherwise break them silently. That pipeline step, not this schema, is what
 * covers the protocol-relative form (`//host/x.png`): hast-util-sanitize only
 * applies `protocols` when a `:` precedes the first `/ ? #`, so it reads such
 * a URL as relative and lets it through.
 *
 * Crucially, sanitize runs BEFORE slug/anchor/mermaid/highlight in the
 * pipeline, so this schema only has to cover what authored Markdown produces.
 */
type Schema = typeof defaultSchema;

const baseProtocols = defaultSchema.protocols ?? {};

export const docsSanitizeSchema: Schema = {
  ...defaultSchema,
  protocols: {
    ...baseProtocols,
    // https only (review #215) — see the note above.
    src: ["https"],
  },
};
