// F-88 (review 2026-09-22): proves on the real `next build` output that each
// docs and help function carries its content, and nothing else from the
// working tree.
//
// The viewers read docs/ and help/ from disk at request time, so a function
// whose trace lacks them answers 500 in production while every other check
// stays green. Until F-88 they got there only because a dynamic
// `path.resolve(process.cwd(), space)` made the tracer ship the WHOLE tree in
// each function (src/, tests/, and a developer checkout's coverage report,
// Playwright traces and .vercel env file when `drk-deploy release` builds
// locally). next.config.mjs now declares the content; this reads each route's
// `.nft.json` (the list `.next/standalone` and Vercel copy files from) and
// checks both halves.
//
// Run by CI after `pnpm build`: `node scripts/check-docs-trace.mjs`.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DOC_IMAGE_EXTENSIONS } from "../next.config.mjs";

/** Every function that reads a content space, by its App Router entry. */
export const DOC_ROUTES = [
  { entry: "app/[locale]/(secure)/app/docs/page", space: "docs", content: "text" },
  { entry: "app/[locale]/(secure)/app/docs/[...slug]/page", space: "docs", content: "text" },
  { entry: "app/[locale]/(secure)/app/help/page", space: "help", content: "text" },
  { entry: "app/[locale]/(secure)/app/help/[...slug]/page", space: "help", content: "text" },
  { entry: "app/api/docs/asset/[...path]/route", space: "docs", content: "images" },
  { entry: "app/api/help/asset/[...path]/route", space: "help", content: "images" },
];

/** What only a whole-tree trace or a local artifact puts in a function. */
const FOREIGN = [
  /^src\//,
  /^tests\//,
  /^scripts\//,
  /^vercel-cli\//,
  /^\.git\//,
  /^\.vercel\//,
  /^coverage\//,
  /^test-results\//,
  /^playwright-report\//,
  /^\.stryker-tmp\//,
  /^\.env/,
  // Root-level notes: README, CHANGELOG, untracked review documents.
  /^[^/]+\.md$/,
];

const CONTENT = {
  text: /\.mdx?$/i,
  images: new RegExp(`\\.(?:${DOC_IMAGE_EXTENSIONS.join("|")})$`, "i"),
};

/** The shipped files of one kind under `<root>/<space>`, root-relative with `/`. */
function shippedContent(root, space, content) {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (CONTENT[content].test(entry.name)) {
        out.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  };
  walk(path.join(root, space));
  return out;
}

const sample = (list) => list.slice(0, 3).join(", ") + (list.length > 3 ? ", …" : "");

/** Every problem with the traces under `<root>/.next`, or an empty list. */
export function checkDocsTrace(root) {
  const problems = [];
  for (const { entry, space, content } of DOC_ROUTES) {
    const nft = path.join(root, ".next", "server", `${entry}.js.nft.json`);
    if (!fs.existsSync(nft)) {
      problems.push(`${entry}: no trace at ${path.relative(root, nft)} (run next build first)`);
      continue;
    }
    const traced = new Set(
      JSON.parse(fs.readFileSync(nft, "utf8")).files.map((file) =>
        path
          .relative(root, path.resolve(path.dirname(nft), file))
          .split(path.sep)
          .join("/"),
      ),
    );

    const expected = shippedContent(root, space, content);
    // A space with no documents is a broken checkout, not a pass.
    if (content === "text" && expected.length === 0) {
      problems.push(`${entry}: ${space}/ holds no documents to check`);
    }
    const missing = expected.filter((file) => !traced.has(file));
    if (missing.length > 0) {
      problems.push(`${entry}: ${missing.length} ${space} file(s) missing: ${sample(missing)}`);
    }
    const foreign = [...traced].filter((file) => FOREIGN.some((re) => re.test(file)));
    if (foreign.length > 0) {
      problems.push(
        `${entry}: ${foreign.length} file(s) from outside its content: ${sample(foreign)}`,
      );
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = checkDocsTrace(process.cwd());
  if (problems.length > 0) {
    console.error("check-docs-trace: the docs/help functions do not carry what they read (F-88):");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      "See docsTracingIncludes in next.config.mjs and getDocsRoot in safe-path.server.ts.",
    );
    process.exit(1);
  }
  console.log(
    `check-docs-trace: ${DOC_ROUTES.length} docs/help functions carry their content only.`,
  );
}
