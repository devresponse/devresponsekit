import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error — operator tooling, plain ESM with no type declarations.
import { assertOk, pickIdFromHrefs } from "../../help/capture-lib.mjs";

/**
 * `help/capture.mjs` is the Playwright screenshot tool behind the in-app help
 * walkthrough. It once hard-coded the demo host and the seed administrator's
 * email + password (source review 2026-09-04, #1), and shipped inside the
 * runtime image because `help/` is copied wholesale (#182). These tests pin
 * the fix: credentials come only from the environment (fail fast when
 * missing), no credential literal is in the file, and the script is excluded
 * from the Docker build context.
 */

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "help", "capture.mjs");
const SOURCE = fs.readFileSync(SCRIPT, "utf8");
const SEED_DEFAULT_PASSWORD = ["ChangeMe", "LocalOnly", "123!"].join("-");

/** Runs the script with a scrubbed environment plus the given CAPTURE_* vars. */
function run(vars: Record<string, string>): { status: number | null; stderr: string } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("CAPTURE_")) env[k] = v;
  }
  const res = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    env: { ...env, ...vars } as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: res.status, stderr: res.stderr };
}

describe("help/capture.mjs reads credentials from the environment only (#1)", () => {
  it("contains no credential or tenant-identity literal", () => {
    expect(SOURCE).not.toContain(SEED_DEFAULT_PASSWORD);
    expect(SOURCE).not.toMatch(/@devresponse\.local/);
    expect(SOURCE).not.toMatch(/demo\.devresponse\.ca/);
    expect(SOURCE).not.toMatch(/(?:PASSWORD|EMAIL|BASE)\s*=\s*["'`]/);
    for (const name of ["CAPTURE_BASE_URL", "CAPTURE_EMAIL", "CAPTURE_PASSWORD"]) {
      expect(SOURCE).toContain(`requireEnv("${name}")`);
    }
  });

  it.each([
    [{}, "CAPTURE_BASE_URL"],
    [{ CAPTURE_BASE_URL: "http://127.0.0.1:9" }, "CAPTURE_EMAIL"],
    [
      { CAPTURE_BASE_URL: "http://127.0.0.1:9", CAPTURE_EMAIL: "someone@example.test" },
      "CAPTURE_PASSWORD",
    ],
  ])(
    "exits non-zero naming the missing variable before touching the network (%o)",
    (vars, missing) => {
      const { status, stderr } = run(vars);
      expect(status).toBe(2);
      expect(stderr).toContain(`missing required environment variable ${missing}`);
    },
  );

  it("rejects a base URL that is not a URL before signing in", () => {
    const { status, stderr } = run({
      CAPTURE_BASE_URL: "not a url",
      CAPTURE_EMAIL: "someone@example.test",
      CAPTURE_PASSWORD: "unused-placeholder",
    });
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/Invalid URL/);
  });
});

describe("help/capture.mjs resolves ids at run time and fails on a bad page (#237)", () => {
  it("hard-codes no entity id", () => {
    // The demo tenant's UUIDs used to be the defaults; a re-seed then produced
    // a wall of 404 screenshots that nothing complained about.
    expect(SOURCE).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("reads each detail id off its list page and asserts every navigation", () => {
    expect(SOURCE).toContain("pickIdFromHrefs(hrefs, segment)");
    expect(SOURCE).toContain("assertOk(response, route)");
    // The h1 wait is an assertion now — a swallowed timeout is what let an
    // error page through.
    expect(SOURCE).not.toMatch(/waitForSelector\("h1"[^)]*\)\s*\.catch/);
    expect(SOURCE).toContain("process.exit(1)");
  });

  it("assertOk accepts a 2xx and rejects anything else", () => {
    expect(assertOk({ status: () => 200 }, "/en")).toBe(200);
    expect(assertOk({ status: () => 204 }, "/en")).toBe(204);
    expect(() => assertOk({ status: () => 404 }, "/en/app/administrator/users/x")).toThrow(
      /HTTP 404/,
    );
    expect(() => assertOk({ status: () => 500 }, "/en")).toThrow(/HTTP 500/);
    expect(() => assertOk(null, "/en")).toThrow(/no HTTP response/);
  });

  it("pickIdFromHrefs takes the first detail id for the segment, and throws when there is none", () => {
    const hrefs = [
      "/en/app/administrator/users",
      "/en/app/administrator/roles/c02b9969-bacf-44e6-8ede-d84405121b3a",
      "/en/app/administrator/users/1ac53f53-dcae-4658-bde3-fd2166fb5d97",
      "/en/app/administrator/users/3a24bf3a-e9cc-45db-b910-a2237aebd6dd",
    ];
    expect(pickIdFromHrefs(hrefs, "users")).toBe("1ac53f53-dcae-4658-bde3-fd2166fb5d97");
    expect(pickIdFromHrefs(hrefs, "roles")).toBe("c02b9969-bacf-44e6-8ede-d84405121b3a");
    // An empty (freshly re-seeded) list must abort, never shoot a 404.
    expect(() => pickIdFromHrefs(["/en/app/administrator/organizations"], "organizations")).toThrow(
      /no \/organizations\/<id> link/,
    );
    expect(() => pickIdFromHrefs(["/en/app/administrator/users/new"], "users")).toThrow();
  });
});

describe("help/capture.mjs is not shipped in the runtime image (#182)", () => {
  it(".dockerignore excludes the capture script but keeps the servable help content", () => {
    const lines = fs
      .readFileSync(path.join(ROOT, ".dockerignore"), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    expect(lines).toContain("help/capture.mjs");
    // The helper module is operator tooling too (#237).
    expect(lines).toContain("help/capture-lib.mjs");
    expect(lines).not.toContain("help");
    expect(lines).not.toContain("help/");
    expect(lines.some((l) => /^help\/(\*|screenshots)/.test(l))).toBe(false);
  });

  it("the served help index no longer names the capture identity or the run command", () => {
    const readme = fs.readFileSync(path.join(ROOT, "help", "README.md"), "utf8");
    expect(readme).not.toMatch(/seed administrator/i);
    expect(readme).not.toMatch(/node help\/capture\.mjs/);
  });
});
