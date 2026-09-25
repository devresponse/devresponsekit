import { resolve } from "node:path";
import { CliError } from "./log.js";

/**
 * Which config file this process acts on, and how a printed command names it
 * (F-50). A module of its own, importing nothing of the CLI's but the error
 * type, so that every module that prints a `drk-deploy` command can name the
 * file without importing `config.ts` (which imports `target.ts`, which prints
 * such commands).
 *
 * One file describes one deployment, and a fleet (the kit plus each
 * satellite) used to share the one default file: every satellite was
 * configured by re-running `init` over the previous deployment's answers, and
 * the operator's workaround was to restore the kit's file before each `init`.
 * With a file per deployment nothing is overwritten, and nothing is inherited
 * from another deployment.
 */

/** The default config file, beside the CLI. */
export const DEFAULT_CONFIG_FILE = ".drk-deploy.json";

/**
 * The config file `--config` or DRK_DEPLOY_CONFIG named, as an absolute path,
 * or null for the default.
 *
 * Set once, by the entry point, from the command line. The commands take the
 * CLI root only, so the file is process state rather than a parameter of each
 * of them. The environment is never read here: a test calling a command
 * directly cannot be redirected to the operator's real config by a shell
 * variable.
 */
let configFileOverride: string | null = null;

/** Selects the config file for this process (F-50): an absolute path, or null for the default. */
export function useConfigFile(file: string | null): void {
  configFileOverride = file;
}

/** The file `--config` or DRK_DEPLOY_CONFIG selected for this process, or null for the default. */
export function selectedConfigFile(): string | null {
  return configFileOverride;
}

/** The config file as a message names it: the selected path, or the default file's name. */
export function configFileLabel(): string {
  return configFileOverride ?? DEFAULT_CONFIG_FILE;
}

/**
 * The config file `--config` or DRK_DEPLOY_CONFIG names, as an absolute path,
 * or null for the default. The flag wins over the variable. An empty variable
 * counts as unset, as a CI step exporting an undefined secret exports "" (the
 * F-47 rule), but an explicit empty `--config` is refused rather than skipped
 * over: the flag says which file was meant.
 *
 * A relative path names a file beside the CLI (`cliRoot`), where the default
 * file is and where `vercel-cli/.gitignore` ignores `.drk-deploy*.json`, not
 * one in the working directory. The `.cmd` wrapper runs from wherever the
 * operator stands, usually the kit's root, where `--from-env .env` is read
 * from: resolved there, `--config .drk-deploy.app-standalone.json` wrote the
 * deployment's project ids and checkout paths into the kit's own tree,
 * unignored, for the next `git add -A`. Beside the CLI, the same command also
 * finds the same file from any directory. An absolute path is used as given.
 */
export function configFileFrom(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  cliRoot: string,
): string | null {
  if (flag !== undefined) {
    if (!flag.trim()) {
      throw new CliError("--config was given an EMPTY value.", {
        hint: "Name the deployment's config file, e.g. --config .drk-deploy.app-standalone.json, or leave the flag out for .drk-deploy.json.",
      });
    }
    return resolve(cliRoot, flag.trim());
  }
  const fromEnv = env.DRK_DEPLOY_CONFIG?.trim();
  return fromEnv ? resolve(cliRoot, fromEnv) : null;
}

/**
 * How to run a command against THIS config: `drk-deploy <command>`, with
 * `--config <file>` when the file is not the default, so a command a hint
 * prints acts on the deployment that printed it (F-50). Printed bare under
 * `--config`, it acted on the default file, which is the kit's in the layout
 * the README recommends: the issuer refusal's `init --project ...` re-pointed
 * the KIT's config at a satellite's project, and a prune hint pruned the kit's
 * project instead of the satellite's.
 *
 * Not for a command that is about ANOTHER deployment's config, such as the
 * kit's `env:sync` a satellite's probe asks for, nor for `login`, which is the
 * user profile's.
 */
export function commandFor(command: string): string {
  return configFileOverride
    ? `drk-deploy --config "${configFileOverride}" ${command}`
    : `drk-deploy ${command}`;
}
