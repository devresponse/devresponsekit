import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * F-67 systemic guard: an Administrator link to ANOTHER page's record is
 * rendered only for a viewer who passes that page's guard.
 *
 * Grids and panels name records other areas own: a member's email, a key's
 * owner, a role, an organization. Their host page checks its own permission,
 * not the destination's, so a viewer holding only the host's (the seeded
 * Limited Admin on a user's Roles tab, an API-key auditor) clicked through to
 * a 404 that also wrote an `administrator.access.denied` row reading like
 * probing. The fix is `PermittedLink`, which renders plain text unless the
 * page passed the destination's read permission as `permitted`.
 *
 * This scans every `<LocaleLink href={`/app/administrator/<area>/${id}`}>`,
 * a link to a detail page, and compares the host's guard key (the nearest
 * `page.tsx` above the file) with the destination's (`<area>/[param]/page.tsx`).
 * Where they differ, the link must be a `PermittedLink`, or render only in the
 * true branch of a flag (`canManage ? <LocaleLink …> : null`, `canX && …`).
 *
 * Either way the flag must be the DESTINATION's guard, so the scan pins it by
 * name from the server page down to the link. A flag guards a destination when
 * - some server page derives it as
 *   `const canReadX = guard.access.permissions.includes("<destination key>")`
 *   (one flag name means one key across every page), or
 * - the link's own file computes it as `const canX = isSuperadmin(guard.access)`
 *   (or `hasCrossOrgReach`) and the destination page refuses with the same
 *   `if (!…)`, as the email template editor's Superadmin gate does (review #73).
 * A literal, a shorthand `permitted`, or another area's flag fails. Every
 * `canRead…=` prop under Administrator must forward the same-named flag
 * (`canReadOrgs={canReadOrgs}`), so a tabs component in between cannot hand a
 * panel some other boolean. admin-page-viewer-flags and the detail-page tests
 * pin that each page computes those flags from the viewer's permissions.
 */
const ADMIN_DIR = join(
  fileURLToPath(new URL("../../src", import.meta.url)),
  "app",
  "[locale]",
  "(secure)",
  "app",
  "administrator",
);

function walkTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTsx(full));
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const FILES = walkTsx(ADMIN_DIR);

/** The single key a page passes to `checkAdminPermissionServer("…")`, if any. */
function guardKeyOf(pageFile: string): string | undefined {
  return /checkAdminPermissionServer\("([^"]+)"\)/.exec(readFileSync(pageFile, "utf8"))?.[1];
}

/** The guard of the nearest `page.tsx` at or above `file`'s directory. */
function hostGuardKey(file: string): string | undefined {
  for (let dir = dirname(file); dir.startsWith(ADMIN_DIR); dir = dirname(dir)) {
    const page = join(dir, "page.tsx");
    if (existsSync(page)) return guardKeyOf(page);
  }
  return undefined;
}

/** `<area>/[param]/page.tsx` for a detail-link prefix like `users/`. */
function destinationPage(areaPath: string): string | undefined {
  const areaDir = join(ADMIN_DIR, ...areaPath.split("/").filter(Boolean));
  if (!existsSync(areaDir)) return undefined;
  const param = readdirSync(areaDir).find((entry) => entry.startsWith("["));
  return param ? join(areaDir, param, "page.tsx") : undefined;
}

/** Every key each `canRead…` flag name is derived from, across the server pages. */
const FLAG_KEYS = new Map<string, Set<string>>();
for (const file of FILES.filter((f) => basename(f) === "page.tsx")) {
  const derived = readFileSync(file, "utf8").matchAll(
    /const (canRead[A-Z]\w*) = guard\.access\.permissions\.includes\("([^"]+)"\)/g,
  );
  for (const [, flag, key] of derived) {
    FLAG_KEYS.set(flag!, (FLAG_KEYS.get(flag!) ?? new Set()).add(key!));
  }
}

/**
 * Whether `flag`, as seen in `file`, is the guard of the page `destination`
 * names: a page-derived `canRead…` flag for exactly the destination's key, or
 * a Superadmin predicate the file computes and the destination refuses on.
 * The latter is the destination's whole guard because
 * `checkAdminPermissionServer` passes a Superadmin on every key, and both
 * predicates imply Superadmin (`hasCrossOrgReach` is Superadmin and not
 * org-bound).
 */
function guardsDestination(flag: string, file: string, destination: string): boolean {
  const keys = FLAG_KEYS.get(flag);
  if (keys) return keys.size === 1 && keys.has(guardKeyOf(destination) ?? "");
  const predicate = new RegExp(
    `const ${flag} = ((?:isSuperadmin|hasCrossOrgReach)\\(guard\\.access\\));`,
  ).exec(readFileSync(file, "utf8"))?.[1];
  return !!predicate && readFileSync(destination, "utf8").includes(`if (!${predicate})`);
}

interface CrossLink {
  tag: string;
  /** e.g. `users/`, from `/app/administrator/users/${id}`. */
  areaPath: string;
  /** The identifier passed as `permitted={…}`, if it is a bare identifier. */
  permitted: string | undefined;
  /** The `permitted` attribute as written, for the failure message. */
  permittedText: string;
  /** Identifiers the link renders under: `flag ? <link> : …` or `flag && <link>`. */
  gates: string[];
  line: number;
}

interface FlagProp {
  name: string;
  /** Forwards the same-named identifier: `canReadOrgs={canReadOrgs}`. */
  forwardsItself: boolean;
  text: string;
  line: number;
}

function jsxAttribute(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
): ts.JsxAttribute | undefined {
  return node.attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name,
  );
}

/** `{name}` → `name`; anything else (a literal, a call, shorthand) → undefined. */
function identifierIn(value: ts.JsxAttributeValue | undefined): string | undefined {
  const expr = value && ts.isJsxExpression(value) ? value.expression : undefined;
  return expr && ts.isIdentifier(expr) ? expr.text : undefined;
}

function scan(file: string): { links: CrossLink[]; flagProps: FlagProp[] } {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const links: CrossLink[] = [];
  const flagProps: FlagProp[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && /^canRead[A-Z]/.test(node.name.getText())) {
      const name = node.name.getText();
      flagProps.push({
        name,
        forwardsItself: identifierIn(node.initializer) === name,
        text: node.getText(),
        line: lineOf(node),
      });
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText();
      const expr = jsxAttribute(node, "href")?.initializer;
      let inner = expr && ts.isJsxExpression(expr) ? expr.expression : undefined;
      if (inner && ts.isAsExpression(inner)) inner = inner.expression;
      const match =
        inner && ts.isTemplateExpression(inner)
          ? /^\/app\/administrator\/([a-z-]+\/(?:[a-z-]+\/)*)$/.exec(inner.head.text)
          : null;
      if ((tag === "LocaleLink" || tag === "PermittedLink") && match) {
        const gates: string[] = [];
        for (let child: ts.Node = node, p = node.parent; p; child = p, p = p.parent) {
          if (ts.isConditionalExpression(p) && p.whenTrue === child) {
            if (ts.isIdentifier(p.condition)) gates.push(p.condition.text);
          }
          if (
            ts.isBinaryExpression(p) &&
            p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
            p.right === child &&
            ts.isIdentifier(p.left)
          ) {
            gates.push(p.left.text);
          }
        }
        const permitted = jsxAttribute(node, "permitted");
        links.push({
          tag,
          areaPath: match[1]!,
          permitted: identifierIn(permitted?.initializer),
          permittedText: permitted ? permitted.getText() : "no `permitted` attribute",
          gates,
          line: lineOf(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { links, flagProps };
}

const rel = (full: string) => full.replace(/\\/g, "/").replace(/^.*administrator\//, "");

const scans = FILES.map((file) => ({ file, ...scan(file) }));

const links = scans.flatMap(({ file, links: found }) =>
  found.map((link) => {
    const destinationFile = destinationPage(link.areaPath);
    return {
      ...link,
      file: rel(file),
      fullPath: file,
      host: hostGuardKey(file),
      destinationFile,
      destination: destinationFile ? guardKeyOf(destinationFile) : undefined,
    };
  }),
);

const flagProps = scans.flatMap(({ file, flagProps: found }) =>
  found.map((prop) => ({ ...prop, file: rel(file) })),
);

describe("F-67: admin cross-links render only for a viewer who passes the destination guard", () => {
  it("finds the detail links, both kinds, and resolves every guard", () => {
    // Thresholds, not exact counts: the scan must not pass vacuously after a
    // rename or a move.
    expect(links.length).toBeGreaterThan(10);
    expect(links.filter((l) => l.tag === "PermittedLink").length).toBeGreaterThanOrEqual(8);
    expect(flagProps.length).toBeGreaterThanOrEqual(15);
    for (const link of links) {
      expect(link.destination, `${link.file}:${link.line} ${link.areaPath}`).toBeDefined();
    }
  });

  it("derives each canRead… flag name from one permission key on every page", () => {
    for (const flag of ["canReadUsers", "canReadRoles", "canReadOrgs"]) {
      expect(FLAG_KEYS.has(flag), `no page derives ${flag}`).toBe(true);
    }
    for (const [flag, keys] of FLAG_KEYS) {
      expect([...keys], `${flag} is derived from different keys on different pages`).toHaveLength(
        1,
      );
    }
  });

  it.each(links.map((l) => [`${l.file}:${l.line} → ${l.areaPath}`, l] as const))(
    "%s",
    (_name, link) => {
      const target = `${link.file}:${link.line} links to ${link.areaPath}[id] (guard ${link.destination})`;
      const guards = (flag: string) =>
        guardsDestination(flag, link.fullPath, link.destinationFile!);
      if (link.tag === "PermittedLink") {
        expect(
          !!link.permitted && guards(link.permitted),
          `${target} with ${link.permittedText}. \`permitted\` must be the flag a server page ` +
            `derives from the destination's guard, e.g. ` +
            `\`const canReadUsers = guard.access.permissions.includes("admin.users.read")\`, ` +
            `passed down as a prop of the same name.`,
        ).toBe(true);
        return;
      }
      if (link.host === link.destination) return;
      expect(
        link.gates.some(guards),
        `${target} from a page guarded on ${link.host}` +
          (link.gates.length ? `, under ${link.gates.join(", ")}` : "") +
          `. A viewer holding only the host's permission would click through to a 404 and ` +
          `an access-denied audit row. Render it with PermittedLink and pass the ` +
          `destination's permission from the server page.`,
      ).toBe(true);
    },
  );

  it.each(flagProps.map((p) => [`${p.file}:${p.line} ${p.name}`, p] as const))(
    "%s forwards the flag of the same name",
    (_name, prop) => {
      expect(
        prop.forwardsItself,
        `${prop.file}:${prop.line} passes \`${prop.text}\`. A canRead… prop carries the ` +
          `server page's permission check; forward it unchanged as \`${prop.name}={${prop.name}}\`.`,
      ).toBe(true);
    },
  );
});
