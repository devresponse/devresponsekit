import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * `.gitleaks.toml` drives the REQUIRED `gitleaks` status check
 * (.github/workflows/secret-scan.yml). These tests pin the policy that keeps
 * that gate honest (source review 2026-09-04, findings #1, #116, #181):
 *
 * - the app's OWN credential formats (`drk_live_`/`drk_test_` API keys,
 *   `drkc_` client ids, `drkcsec_` client secrets) have DETECTION rules that
 *   match the real shapes the app generates, and are never globally
 *   allowlisted — so a genuine key committed anywhere in the tree fails CI;
 * - every fixture value in the tree stays shorter than the real shape, so the
 *   rules and the fixtures never collide (no allowlist needed);
 * - the documented seed-admin default password is detected everywhere except
 *   the handful of files that DOCUMENT the local-only default (path-scoped,
 *   not global) — a copy in tooling or app code trips the gate;
 * - no dead allowlist entry survives (each global regex still has a match).
 *
 * The parser below understands only the TOML subset the config uses (tables,
 * array tables, strings, numbers, and arrays of strings); it is deliberately
 * tiny so the test needs no extra dependency.
 */

const ROOT = path.resolve(__dirname, "..", "..");
const CONFIG_PATH = path.join(ROOT, ".gitleaks.toml");

type Block = { header: string; values: Record<string, string | number | string[]> };

/** Parses the TOML subset used by .gitleaks.toml into ordered header blocks. */
function parseBlocks(toml: string): Block[] {
  const blocks: Block[] = [{ header: "", values: {} }];
  const lines = toml.split(/\r?\n/);
  const stripComment = (s: string): string => {
    // A `#` outside quotes starts a comment (the config never puts `#` in a value
    // except inside ''' regexes, which contain no `#`).
    const i = s.indexOf("#");
    return i === -1 ? s : s.slice(0, i);
  };
  const parseScalar = (raw: string): string | number => {
    const m3 = /^'''(.*)'''$/s.exec(raw);
    if (m3) return m3[1]!;
    const m1 = /^'(.*)'$/.exec(raw);
    if (m1) return m1[1]!;
    const m2 = /^"(.*)"$/.exec(raw);
    if (m2) return m2[1]!;
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    if (raw === "true" || raw === "false") return raw;
    throw new Error(`unsupported TOML scalar: ${raw}`);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]!).trim();
    if (!line) continue;
    const header = /^\[\[?([^\]]+)\]?\]$/.exec(line);
    if (header) {
      blocks.push({ header: header[1]!.trim(), values: {} });
      continue;
    }
    const kv = /^([A-Za-z_]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`unparsed TOML line ${i + 1}: ${lines[i]}`);
    const key = kv[1]!;
    let rest = kv[2]!.trim();
    const current = blocks[blocks.length - 1]!;
    if (rest.startsWith("[")) {
      // Array of strings; may span lines until the closing `]`.
      let body = rest.slice(1);
      while (!/\]\s*$/.test(body)) {
        i++;
        if (i >= lines.length) throw new Error("unterminated TOML array");
        body += "\n" + stripComment(lines[i]!);
      }
      body = body.replace(/\]\s*$/, "");
      // Items are quoted strings; a comma may legitimately appear INSIDE a
      // '''regex''' (e.g. `{1,12}`), so tokenize by quotes, not by commas.
      const items = [...body.matchAll(/'''[\s\S]*?'''|"[^"]*"|'[^']*'/g)].map((m) =>
        String(parseScalar(m[0])),
      );
      current.values[key] = items;
    } else {
      rest = rest.replace(/,\s*$/, "");
      current.values[key] = parseScalar(rest);
    }
  }
  return blocks;
}

type Rule = { id: string; regex: RegExp; path?: RegExp; entropy?: number; allowPaths: RegExp[] };

/** Converts a Go RE2 pattern from the config into an equivalent JS RegExp. */
function goRegex(pattern: string): RegExp {
  let flags = "";
  let src = pattern;
  if (src.startsWith("(?i)")) {
    flags += "i";
    src = src.slice(4);
  }
  return new RegExp(src, flags);
}

type GlobalAllowlist = {
  condition?: string;
  targetRules: string[];
  paths: RegExp[];
  regexes: string[];
};

function loadConfig(): {
  rules: Rule[];
  globalAllowlists: GlobalAllowlist[];
  /** Regexes of the UNSCOPED global allowlists (no path fence, no target rule). */
  globalRegexes: string[];
  /** Paths of the path-only global allowlists. */
  globalPaths: RegExp[];
} {
  const blocks = parseBlocks(fs.readFileSync(CONFIG_PATH, "utf8"));
  const rules: Rule[] = [];
  const globalAllowlists: GlobalAllowlist[] = [];
  const globalRegexes: string[] = [];
  const globalPaths: RegExp[] = [];
  for (const block of blocks) {
    if (block.header === "rules") {
      const path = block.values.path;
      rules.push({
        id: String(block.values.id),
        regex: goRegex(String(block.values.regex)),
        ...(typeof path === "string" ? { path: goRegex(path) } : {}),
        ...(typeof block.values.entropy === "number" ? { entropy: block.values.entropy } : {}),
        allowPaths: [],
      });
    } else if (block.header === "rules.allowlists") {
      const paths = block.values.paths;
      if (Array.isArray(paths)) rules[rules.length - 1]!.allowPaths.push(...paths.map(goRegex));
    } else if (block.header === "allowlists") {
      const regexes = block.values.regexes;
      const paths = block.values.paths;
      const targetRules = block.values.targetRules;
      const entry: GlobalAllowlist = {
        ...(typeof block.values.condition === "string"
          ? { condition: block.values.condition }
          : {}),
        targetRules: Array.isArray(targetRules) ? targetRules : [],
        paths: Array.isArray(paths) ? paths.map(goRegex) : [],
        regexes: Array.isArray(regexes) ? regexes : [],
      };
      globalAllowlists.push(entry);
      if (entry.paths.length === 0 && entry.targetRules.length === 0)
        globalRegexes.push(...entry.regexes);
      if (entry.regexes.length === 0) globalPaths.push(...entry.paths);
    }
  }
  return { rules, globalAllowlists, globalRegexes, globalPaths };
}

const CONFIG = loadConfig();
const ruleById = (id: string): Rule => {
  const rule = CONFIG.rules.find((r) => r.id === id);
  if (!rule) throw new Error(`rule ${id} missing from .gitleaks.toml`);
  return rule;
};

/** Shannon entropy in bits/char — the measure gitleaks applies to the secret group. */
function shannon(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// The base62 alphabet the app uses (src/lib/api-auth/api-key.ts). Slicing it
// yields distinct-character "random" segments of any length with maximal
// entropy WITHOUT a full-length literal credential ever appearing in this
// file (which would itself trip the scan).
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const synthetic = (prefix: string, length: number): string => prefix + BASE62.slice(0, length);
const SEED_DEFAULT_PASSWORD = ["ChangeMe", "LocalOnly", "123!"].join("-");

const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".js",
  ".md",
  ".mdx",
  ".yml",
  ".yaml",
  ".json",
  ".toml",
  ".sql",
  ".txt",
  ".csv",
  ".ps1",
  ".sh",
  ".example",
]);
const SCAN_DIRS = [".github", "docs", "help", "scripts", "src", "tests"];

/**
 * Every COMMITTED text file the scan covers — CI scans a fresh checkout, so
 * `git ls-files` is the honest file list (a local, untracked report that
 * quotes a dummy value must not fail this test). Falls back to a directory
 * walk of the source roots when git is unavailable.
 */
function* treeFiles(): Generator<{ rel: string; text: string }> {
  let files: string[];
  try {
    files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
  } catch {
    const walk = function* (dir: string): Generator<string> {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".next")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(full);
        else yield path.relative(ROOT, full);
      }
    };
    files = fs
      .readdirSync(ROOT, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
    for (const dir of SCAN_DIRS) {
      if (fs.existsSync(path.join(ROOT, dir))) files.push(...walk(path.join(ROOT, dir)));
    }
  }
  for (const file of files) {
    const rel = file.split(path.sep).join("/");
    const ext = path.extname(rel) || (path.basename(rel).startsWith(".env") ? ".example" : "");
    if (!TEXT_EXT.has(ext)) continue;
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue; // staged deletion
    yield { rel, text: fs.readFileSync(full, "utf8") };
  }
}

describe(".gitleaks.toml — detection rules for the app's own credential formats (#181)", () => {
  it("defines a rule per credential family and none of them is globally allowlisted", () => {
    for (const id of [
      "devresponse-api-key",
      "devresponse-oauth-client-secret",
      "devresponse-oauth-client-id",
    ]) {
      expect(ruleById(id).entropy).toBeGreaterThanOrEqual(3.5);
    }
    // The pre-fix config carried `drk(_(live|test)_|c_|csec_)[A-Za-z0-9_-]+`
    // as a GLOBAL regex allowlist — which suppressed every real key.
    expect(CONFIG.globalRegexes.join("\n")).not.toMatch(/drk/);
  });

  it.each([
    ["devresponse-api-key", "drk_live_", 32],
    ["devresponse-api-key", "drk_test_", 32],
    ["devresponse-oauth-client-secret", "drkcsec_", 40],
    ["devresponse-oauth-client-id", "drkc_", 24],
  ])(
    "%s catches a real-shaped %s credential (%i random chars) above the entropy floor",
    (id, prefix, length) => {
      const rule = ruleById(id);
      const value = synthetic(prefix, length);
      const match = rule.regex.exec(`Authorization: Bearer ${value}\n`);
      expect(match?.[0]).toBe(value);
      expect(shannon(match![1]!)).toBeGreaterThanOrEqual(rule.entropy!);
      // Off-by-one on either side is NOT the real shape and must not be claimed.
      expect(rule.regex.test(synthetic(prefix, length - 1) + " ")).toBe(false);
      expect(rule.regex.test(synthetic(prefix, length + 1))).toBe(false);
    },
  );

  it("does not collide with any fixture in the tree (fixtures stay shorter than the real shapes)", () => {
    const family = /\bdrk(?:_(?:live|test)_|c_|csec_)[A-Za-z0-9_-]+/g;
    const rules = [
      "devresponse-api-key",
      "devresponse-oauth-client-secret",
      "devresponse-oauth-client-id",
    ].map(ruleById);
    const collisions: string[] = [];
    let fixtures = 0;
    for (const { rel, text } of treeFiles()) {
      if (rel === ".gitleaks.toml") continue;
      for (const token of text.match(family) ?? []) {
        fixtures++;
        for (const rule of rules)
          if (rule.regex.test(token)) collisions.push(`${rel}: ${token} (${rule.id})`);
      }
    }
    expect(fixtures).toBeGreaterThan(20); // the fixtures exist — the sweep is real
    expect(collisions).toEqual([]);
  });

  it("fences the only allowance for the family: short fixtures, tests/+docs/ only, generic rule only", () => {
    const family = CONFIG.globalAllowlists.filter((a) => a.regexes.join("\n").includes("drk"));
    expect(family.length).toBe(1);
    const fence = family[0]!;
    // Path fence is a hard AND (OR would allowlist the value everywhere).
    expect(fence.condition).toBe("AND");
    expect(fence.paths.length).toBeGreaterThan(0);
    for (const p of fence.paths) {
      expect(p.test("tests/unit/x.test.ts")).toBe(true);
      expect(p.test("docs/api.md")).toBe(true);
      for (const rel of [
        "src/lib/env.ts",
        "help/capture.mjs",
        "scripts/x.mjs",
        ".github/workflows/ci.yml",
      ]) {
        expect(p.test(rel), `${p.source} fences ${rel}`).toBe(false);
      }
    }
    // Only the bundled generic rule — never the app's own detection rules.
    expect(fence.targetRules).toEqual(["generic-api-key"]);
    // Length fence: the public display prefix passes, real shapes never do.
    const [regex] = fence.regexes.map(goRegex);
    expect(regex!.test("drk_live_AbCd1234")).toBe(true);
    expect(regex!.test("drk_live_AbCd1234EfGh")).toBe(true);
    expect(regex!.test(synthetic("drk_live_", 32))).toBe(false);
    expect(regex!.test(synthetic("drk_test_", 32))).toBe(false);
    expect(regex!.test(synthetic("drkcsec_", 40))).toBe(false);
    expect(regex!.test(synthetic("drkc_", 24))).toBe(false);
    expect(regex!.test(synthetic("drk_live_", 13))).toBe(false);
  });

  it("only allows a full-length placeholder under tests/ or docs/ (never under src/ or help/)", () => {
    for (const rule of [
      "devresponse-api-key",
      "devresponse-oauth-client-secret",
      "devresponse-oauth-client-id",
    ].map(ruleById)) {
      expect(rule.allowPaths.length).toBeGreaterThan(0);
      for (const p of rule.allowPaths) {
        expect(p.test("tests/unit/x.test.ts")).toBe(true);
        expect(p.test("docs/api.md")).toBe(true);
        expect(p.test("src/lib/api-auth/api-key.ts")).toBe(false);
        expect(p.test("help/capture.mjs")).toBe(false);
      }
    }
  });
});

describe(".gitleaks.toml — the seed-admin default password is path-scoped, not global (#1)", () => {
  const rule = ruleById("devresponse-seed-default-password");
  const allowed = (rel: string): boolean => rule.allowPaths.some((p) => p.test(rel));

  it("has a detection rule for the literal and no global allowlist for it", () => {
    expect(rule.regex.test(`const PASSWORD = "${SEED_DEFAULT_PASSWORD}";`)).toBe(true);
    expect(CONFIG.globalRegexes.join("\n")).not.toMatch(/ChangeMe/);
    expect(CONFIG.globalRegexes).not.toContain("change-me-min-16-chars"); // dead entry (#116)
  });

  it("allowlists exactly the files that document the default — every file holding it is documentation, tooling is not", () => {
    const holders: string[] = [];
    for (const { rel, text } of treeFiles())
      if (text.includes(SEED_DEFAULT_PASSWORD)) holders.push(rel);
    expect(holders).toContain("docs/developer-onboarding.md");
    expect(holders).not.toContain("help/capture.mjs");
    const unallowed = holders.filter((rel) => !allowed(rel));
    expect(unallowed).toEqual([]);
    // Tooling and application code are never allowlisted, so a copy there fails the gate.
    for (const rel of [
      "help/capture.mjs",
      "scripts/verify-local-sso.mjs",
      "src/db/seeds/seed-local.ts",
      "src/lib/env.ts",
    ]) {
      expect(allowed(rel)).toBe(false);
    }
  });
});

describe(".gitleaks.toml — quoted password literals in operator tooling (#1)", () => {
  const rule = ruleById("devresponse-tooling-hardcoded-password");

  it("scopes the rule to help/ and scripts/ tooling files", () => {
    expect(rule.path!.test("help/capture.mjs")).toBe(true);
    expect(rule.path!.test("scripts/verify-local-sso.mjs")).toBe(true);
    expect(rule.path!.test("scripts/setup-local-subdomains.ps1")).toBe(true);
    expect(rule.path!.test("help/README.md")).toBe(false);
    expect(rule.path!.test("src/lib/env.ts")).toBe(false);
  });

  it("flags the pre-fix assignment and not an env-sourced one", () => {
    const leaked = rule.regex.exec(`const PASSWORD = "${SEED_DEFAULT_PASSWORD}";`);
    expect(leaked?.[1]).toBe(SEED_DEFAULT_PASSWORD);
    expect(shannon(leaked![1]!)).toBeGreaterThanOrEqual(rule.entropy!);
    expect(rule.regex.test('const PASSWORD = requireEnv("CAPTURE_PASSWORD");')).toBe(false);
    expect(rule.regex.test('const PASSWORD = process.env.SSO_VERIFY_PASSWORD ?? "x";')).toBe(false);
  });

  it("does not fire on the tooling actually in the tree", () => {
    const hits: string[] = [];
    for (const { rel, text } of treeFiles()) {
      if (!rule.path!.test(rel)) continue;
      const m = new RegExp(rule.regex.source, rule.regex.flags + "g");
      for (const hit of text.matchAll(m))
        if (shannon(hit[1]!) >= rule.entropy!) hits.push(`${rel}: ${hit[0]}`);
    }
    expect(hits).toEqual([]);
  });
});

describe(".gitleaks.toml — global allowlists stay minimal (#116)", () => {
  it("every global regex still matches something in the tree (no dead entries)", () => {
    const files = [...treeFiles()].filter((f) => f.rel !== ".gitleaks.toml");
    for (const pattern of CONFIG.globalRegexes) {
      const re = goRegex(pattern);
      expect(
        files.some((f) => re.test(f.text)),
        `dead allowlist regex: ${pattern}`,
      ).toBe(true);
    }
  });

  it("never blanket-allowlists tests/, src/, help/ or scripts/ by path", () => {
    for (const p of CONFIG.globalPaths) {
      for (const rel of [
        "tests/unit/x.test.ts",
        "src/lib/env.ts",
        "help/capture.mjs",
        "scripts/x.mjs",
      ]) {
        expect(p.test(rel), `${p.source} allowlists ${rel}`).toBe(false);
      }
    }
  });
});
