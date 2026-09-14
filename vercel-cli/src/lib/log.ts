/**
 * Console output for a tool that handles credentials.
 *
 * Every value this CLI pushes to Vercel is a secret (signing keys, database
 * URLs, cron tokens). Nothing here ever prints one: `mask()` is the only way a
 * secret-shaped value reaches stdout, and it shows a length and a fingerprint
 * rather than any part of the value itself. A CI log, a screen share and a
 * pasted bug report all see the same safe text.
 */

import { createHash } from "node:crypto";

/** Windows terminals inherit ANSI support from the host; honour NO_COLOR too. */
const useColor = process.env.NO_COLOR === undefined && process.stdout.isTTY === true;

const paint = (code: string, text: string): string => (useColor ? `[${code}m${text}[0m` : text);

export const bold = (t: string): string => paint("1", t);
export const dim = (t: string): string => paint("2", t);
export const red = (t: string): string => paint("31", t);
export const green = (t: string): string => paint("32", t);
export const yellow = (t: string): string => paint("33", t);
export const blue = (t: string): string => paint("36", t);

let quiet = false;
export function setQuiet(value: boolean): void {
  quiet = value;
}

export function info(message: string): void {
  if (!quiet) process.stdout.write(`${message}\n`);
}

export function step(message: string): void {
  if (!quiet) process.stdout.write(`${blue("→")} ${message}\n`);
}

export function ok(message: string): void {
  if (!quiet) process.stdout.write(`${green("✓")} ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`${yellow("!")} ${message}\n`);
}

export function fail(message: string): void {
  process.stderr.write(`${red("✗")} ${message}\n`);
}

export function heading(title: string): void {
  if (quiet) return;
  process.stdout.write(`\n${bold(title)}\n${dim("─".repeat(Math.max(8, title.length)))}\n`);
}

/** A key/value line with the keys aligned, for status output. */
export function field(label: string, value: string, width = 26): void {
  if (!quiet) process.stdout.write(`  ${label.padEnd(width)} ${value}\n`);
}

/**
 * The ONLY representation of a secret this tool will print: its length plus a
 * short non-reversible fingerprint, so two runs can be compared ("is the value
 * on Vercel the one I generated?") without the value ever being displayed.
 */
export function mask(value: string | undefined | null): string {
  if (value === undefined || value === null || value === "") return dim("(unset)");
  return dim(`(set, ${value.length} chars, fp ${fingerprint(value)})`);
}

/** First 8 hex chars of a SHA-256 — enough to compare, useless to an attacker. */
export function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/** A non-fatal, expected error carrying an exit code and no stack trace. */
export class CliError extends Error {
  readonly exitCode: number;
  readonly hint: string | undefined;

  constructor(message: string, options: { exitCode?: number; hint?: string } = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = options.exitCode ?? 1;
    this.hint = options.hint;
  }
}
