import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { CliError, dim, info } from "./log.js";

export interface RunOptions {
  cwd: string;
  /**
   * Variables layered over what the child inherits ({@link inheritedEnv}),
   * for the child only. An `undefined` value removes a variable.
   */
  env?: Record<string, string | undefined>;
  /**
   * Inherit this process's whole environment, minus the Vercel token, instead
   * of the allow-list. Only the kit's migration runners ask for it (F-139).
   */
  inheritShell?: boolean;
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
 * The variables a child inherits from this process (F-139): what `git`, pnpm,
 * node and the Vercel CLI need to run on this machine, and no application
 * value. No credential either, save a proxy's own login inside a proxy URL,
 * without which the child cannot reach the network at all.
 *
 * Every child used to get `process.env` whole. `vercel build` then ran the
 * checkout's `next build`, every dependency's code included, holding the
 * account-wide VERCEL_TOKEN (which CI exports, and which decrypts and deploys
 * every project the account reaches) and every secret the operator had
 * exported, such as PRODUCTION_DIRECT_DATABASE_URL. A shell's
 * NEXT_PUBLIC_APP_URL=http://localhost:3000 also beat production's pulled
 * value, and was inlined into the production client bundle.
 *
 * Names are matched case-insensitively: on Windows `Path` is PATH, and the
 * proxy variables are conventionally lower-case elsewhere. NODE_ENV is left
 * out on purpose: `next build` sets its own, and a shell's `production`
 * would have `pnpm install` skip the devDependencies (tsx) migrations run on.
 */
const INHERITED: ReadonlySet<string> = new Set([
  // The system: where programs, the home and temp folders are, locale, terminal.
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "COLORTERM",
  // Windows: networking in a child needs SystemRoot, and finding or starting
  // a .cmd shim needs PATHEXT and ComSpec.
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "OS",
  "USERPROFILE",
  "USERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ALLUSERSPROFILE",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
  "NUMBER_OF_PROCESSORS",
  // The network: a proxy, and the CAs a corporate one needs trusted.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_SYSTEM_CA",
  "NODE_USE_ENV_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // The toolchain, and how it behaves: non-interactive in CI, colour, telemetry.
  "NODE_OPTIONS",
  "PNPM_HOME",
  "CI",
  "FORCE_COLOR",
  "NO_COLOR",
  "DO_NOT_TRACK",
  "NEXT_TELEMETRY_DISABLED",
  "VERCEL_TELEMETRY_DISABLED",
]);

/** Families inherited by prefix: locale, XDG folders, npm/pnpm and corepack configuration. */
const INHERITED_PREFIXES = ["LC_", "XDG_", "NPM_CONFIG_", "PNPM_CONFIG_", "COREPACK_"];

/**
 * The registry logins those families also carry, which stay behind:
 * COREPACK_NPM_TOKEN/_USERNAME/_PASSWORD, and npm/pnpm's `_auth`,
 * `_authToken`, `_password`, `username`, `otp` and client `key`, bare or
 * per registry (`npm_config_//registry.npmjs.org/:_authToken`).
 */
const REGISTRY_LOGIN = /[_:](?:AUTH|AUTHTOKEN|PASSWORD|TOKEN|USERNAME|OTP|KEY)$/;

/** The Vercel CLI reads its token from either name (`getPlatformEnv`). */
const TOKEN_NAMES = ["VERCEL_TOKEN", "NOW_TOKEN"];

/**
 * What a child inherits from `shell` before `RunOptions.env` is layered on:
 * the allow-list above or, with `whole`, everything. Never the Vercel token,
 * in any casing: the `vercel` steps that need it are handed it by name
 * (`vercelEnvFor`), so no other child can pick it up on the way (F-139).
 */
export function inheritedEnv(shell: NodeJS.ProcessEnv = process.env, whole = false): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(shell)) {
    if (value === undefined) continue;
    const name = key.toUpperCase();
    if (TOKEN_NAMES.includes(name)) continue;
    const family = INHERITED_PREFIXES.some((prefix) => name.startsWith(prefix)) && !REGISTRY_LOGIN.test(name);
    if (whole || INHERITED.has(name) || family) env[key] = value;
  }
  return env;
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
 *
 * That environment is {@link inheritedEnv} plus `options.env`, never
 * `process.env` whole (F-139).
 */
export function run(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  if (options.echo) info(dim(`  $ ${command} ${args.join(" ")}`));
  // Only a .cmd/.bat shim needs the shell; a real executable never does.
  const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);

  return new Promise((resolve, reject) => {
    // Quoted, because the shell splits the command line at spaces: a corepack
    // shim at C:\Program Files\nodejs\pnpm.cmd ran `C:\Program`, so `migrate`
    // failed and `doctor` reported a working pnpm as missing (F-145).
    const child = spawn(shell ? `"${command}"` : command, args, {
      cwd: options.cwd,
      env: { ...inheritedEnv(process.env, options.inheritShell), ...options.env },
      shell,
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
 * unfamiliar (a Homebrew or corepack install), which still works: `run` quotes
 * the shim's path for the shell, spaces and all (F-145).
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
