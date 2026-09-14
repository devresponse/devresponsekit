import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { CliError, dim, info } from "./log.js";

export interface RunOptions {
  cwd: string;
  /** Extra variables layered over `process.env` for the child only. */
  env?: Record<string, string | undefined>;
  /** Stream the child's output to this process (default) or capture it. */
  capture?: boolean;
  /** Print the command before running it. Values are never printed. */
  echo?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a child process and resolves with its exit code and output.
 *
 * Windows shells out ONLY for `.cmd`/`.bat` shims (pnpm), because Node cannot
 * exec those directly. That path concatenates arguments rather than passing
 * them as a vector, so the rule this CLI follows is absolute: **no secret is
 * ever passed as an argument**. Connection strings, tokens and signing keys
 * travel in the child's environment instead, where no shell can re-parse them.
 * Everything else (node, the Vercel CLI's JS entry) runs with `shell: false`.
 */
export function run(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  if (options.echo) info(dim(`  $ ${command} ${args.join(" ")}`));

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      // Only a .cmd/.bat shim needs the shell; a real executable never does.
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      reject(
        new CliError(`Could not start \`${command}\`: ${err.message}`, {
          hint:
            command === "pnpm"
              ? "pnpm is required. Install it with `npm i -g pnpm@10` or enable corepack."
              : undefined,
        }),
      );
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Same as {@link run}, but a non-zero exit becomes a CliError. */
export async function runOrThrow(
  command: string,
  args: string[],
  options: RunOptions & { failureMessage?: string },
): Promise<RunResult> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const detail = options.capture ? `\n${result.stderr.trim() || result.stdout.trim()}` : "";
    throw new CliError(
      `${options.failureMessage ?? `\`${command} ${args[0] ?? ""}\` failed`} (exit ${result.code})${detail}`,
    );
  }
  return result;
}

/**
 * How to invoke pnpm without a shell.
 *
 * A global pnpm install puts a `.cmd` shim on PATH, and Node can only run that
 * through a shell — which concatenates arguments and, on Node 24, warns about
 * exactly that. The shim is a thin wrapper around `pnpm.cjs`, so when that file
 * can be found this runs it with `node` directly: no shell, no warning, and
 * arguments passed as a real vector. Falls back to the shim when the layout is
 * unfamiliar (a Homebrew or corepack install), which still works.
 */
export function pnpmCommand(): { command: string; prefix: string[] } {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const shim = join(dir, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
    if (!existsSync(shim)) continue;
    const cjs = join(dir, "node_modules", "pnpm", "bin", "pnpm.cjs");
    if (existsSync(cjs)) return { command: process.execPath, prefix: [cjs] };
    return { command: shim, prefix: [] };
  }
  return { command: process.platform === "win32" ? "pnpm.cmd" : "pnpm", prefix: [] };
}

/** Runs a pnpm script without going through a shell where that is avoidable. */
export function runPnpm(
  args: string[],
  options: RunOptions & { failureMessage?: string },
): Promise<RunResult> {
  const { command, prefix } = pnpmCommand();
  return runOrThrow(command, [...prefix, ...args], options);
}
