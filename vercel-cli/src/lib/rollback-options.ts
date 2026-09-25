import type { Command } from "commander";

/**
 * The flags that decide what an unhealthy post-deploy probe does, for the two
 * commands that promote, `deploy` and `up` (F-51): `--rollback-on-fail`,
 * `--no-rollback-on-fail`, and `-y, --yes` with the command's own help text.
 *
 * Both rollback flags are declared. Commander gives a LONE `--no-x` a default
 * of true, so declaring only the negative one would roll back every run, with
 * or without `--yes`. With both declared, a run that gives neither leaves
 * `rollbackOnFail` undefined, and `--yes` decides (`rollbackPolicy` in
 * commands/release.ts). Their order does not matter: commander 15 settles a
 * negated option's default once every option is declared. test/unit.test.ts
 * pins the parse.
 */
export function withRollbackOptions(command: Command, yes: string): Command {
  return command
    .option(
      "--rollback-on-fail",
      "if the post-deploy probe fails, promote the deployment production served before this run back (`vercel promote`) and probe again: exit 4 when that restores a healthy production, 5 when it does not. On by default under --yes",
    )
    .option(
      "--no-rollback-on-fail",
      "leave a build that fails its probe live (exit 3), even under --yes; the rollback command is printed",
    )
    .option("-y, --yes", yes);
}
