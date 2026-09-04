import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

describe("help/capture.mjs is not shipped in the runtime image (#182)", () => {
  it(".dockerignore excludes the capture script but keeps the servable help content", () => {
    const lines = fs
      .readFileSync(path.join(ROOT, ".dockerignore"), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    expect(lines).toContain("help/capture.mjs");
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
