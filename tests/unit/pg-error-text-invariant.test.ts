import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * F-132: a Postgres constraint violation is recognised by its SQLSTATE and
 * constraint, through `src/db/pg-errors.ts`, never by its message.
 *
 * Ten admin routes used to map a unique violation to their 409 with
 * `/duplicate key|unique constraint/i.test(err.message)`, four more a foreign
 * key violation with `/foreign key/i`, and the tenant DELETE matched a
 * constraint NAME against the message. The message follows the server's
 * `lc_messages`, so on a server set to another language every one of them
 * missed and the caller got a 500; and the unique pattern matched every unique
 * index on the table, whichever one the 409 was meant for. The copy-paste is
 * how the pattern spread, so a new route could bring it back and every
 * behavioural test would still pass (they all used the English text).
 *
 * This scans the TypeScript AST of every source file under `src` and fails on:
 *   - a regular-expression literal that looks for Postgres' message text or a
 *     constraint name (`…_key`, `…_pkey`, `…_fkey`);
 *   - a string or template literal carrying that message text (the
 *     `.includes("duplicate key")` and `new RegExp("foreign key")` spellings).
 * Comments are not code, so the AST scan ignores them.
 */
const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));

/** Postgres' English message text for 23505 / 23503. */
const MESSAGE_TEXT = /duplicate key|unique constraint|foreign key|violates/i;
/** The same, or a constraint name, searched for with a regex. */
const REGEX_TEXT = /duplicate key|unique constraint|foreign key|violates|_p?f?key\b/i;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Every message-text match in one source file, as `line: literal`. */
function messageTextMatches(fileName: string, source: string): string[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const at = (node: ts.Node) =>
    found.push(`${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${node.getText()}`);

  const visit = (node: ts.Node) => {
    if (ts.isRegularExpressionLiteral(node)) {
      if (REGEX_TEXT.test(node.text)) at(node);
    } else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      if (MESSAGE_TEXT.test(node.text)) at(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("F-132: no Postgres error is recognised by its message text", () => {
  it("catches each spelling it forbids, and not the SQLSTATE form or a comment", () => {
    const flagged = messageTextMatches(
      "probe.ts",
      [
        `if (/duplicate key|unique constraint/i.test(message)) {}`,
        `if (/foreign key/i.test(message)) {}`,
        `if (/app_audit_events_organization_id_fkey/i.test(message)) {}`,
        `if (message.includes("duplicate key")) {}`,
        "if (new RegExp(`violates ${x}`).test(message)) {}",
        `// the old /duplicate key/i match is gone`,
        `if (isUniqueViolation(err, "app_organizations_slug_key")) {}`,
        `if (/email/i.test(constraint)) {}`,
      ].join("\n"),
    );
    expect(flagged.map((f) => f.split(":")[0])).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("finds none under src", () => {
    const offenders = walk(SRC_DIR).flatMap((file) =>
      messageTextMatches(file, readFileSync(file, "utf8")).map(
        (match) => `${relative(SRC_DIR, file).replaceAll("\\", "/")}:${match}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
