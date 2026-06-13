import { defaultSchema } from "rehype-sanitize";

/**
 * Hardened sanitize schema for the docs pipeline.
 *
 * Built on rehype-sanitize's `defaultSchema` (which already strips
 * `<script>`/`<style>`, event-handler attributes, and dangerous URL
 * protocols). We extend ONLY what the trusted post-sanitize transforms
 * need:
 *
 *   - `className` on `code`/`pre`/`span` so the `language-*` hint survives
 *     for the syntax highlighter (class names cannot execute code).
 *
 * Crucially, sanitize runs BEFORE slug/anchor/highlight in the pipeline,
 * so this schema only has to cover what authored Markdown produces — the
 * ids, anchors, and Shiki styles added afterward come from our own
 * trusted code, not from document content.
 */
type Schema = typeof defaultSchema;

const baseAttributes = defaultSchema.attributes ?? {};

export const docsSanitizeSchema: Schema = {
  ...defaultSchema,
  attributes: {
    ...baseAttributes,
    code: [...(baseAttributes.code ?? []), "className"],
    pre: [...(baseAttributes.pre ?? []), "className"],
    span: [...(baseAttributes.span ?? []), "className"],
  },
};
