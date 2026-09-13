import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveToken, tokenSource } from "../lib/config.js";
import { pnpmCommand, run } from "../lib/exec.js";
import { coreMigrations } from "../lib/kit.js";
import { dim, field, green, heading, info, ok, red, warn, yellow } from "../lib/log.js";
import { VercelClient } from "../lib/vercel-client.js";

const PASS = green("ok");
const FAIL = red("missing");

/**
 * `drk-deploy doctor` — checks the machine and the link before anything is
 * changed, so a deploy fails here (cheaply, with a fix) rather than halfway
 * through a promotion.
 */
export async function doctor(cliRoot: string): Promise<number> {
  let problems = 0;
  const bad = (message: string): string => {
    problems += 1;
    return message;
  };

  heading("Toolchain");
  const node = process.versions.node;
  const nodeMajor = Number(node.split(".")[0]);
  field(
    "node",
    nodeMajor >= 24 ? `${PASS} ${dim(`v${node}`)}` : bad(`${red(`v${node}`)} — the kit needs Node 24+`),
  );

  const pnpm = pnpmCommand();
  const pnpmResult = await run(pnpm.command, [...pnpm.prefix, "--version"], { cwd: cliRoot, capture: true });
  field(
    "pnpm",
    pnpmResult.code === 0
      ? `${PASS} ${dim(pnpmResult.stdout.trim())}`
      : bad(`${FAIL} — needed to run migrations`),
  );

  const vercelBin = join(
    cliRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "vercel.cmd" : "vercel",
  );
  field("vercel cli", existsSync(vercelBin) ? PASS : bad(`${FAIL} — run \`pnpm install\` in vercel-cli`));

  heading("Credentials");
  const source = tokenSource();
  field(
    "token",
    source === "none"
      ? bad(`${FAIL} — run \`drk-deploy login\``)
      : `${PASS} ${dim(source === "env" ? "from VERCEL_TOKEN" : "from the user profile")}`,
  );

  if (source !== "none") {
    try {
      await new VercelClient(resolveToken()!).whoami();
      field("api reachable", PASS);
    } catch (err) {
      field("api reachable", bad(`${red("failed")} — ${(err as Error).message}`));
    }
  }

  heading("Project link");
  const config = loadConfig(cliRoot);
  if (!config) {
    field("config", bad(`${FAIL} — run \`drk-deploy init\``));
  } else {
    field("project", `${PASS} ${dim(config.projectId)}`);
    field("origin", config.origin);
    const kitOk = existsSync(join(config.kitRoot, "package.json"));
    field(
      "kit checkout",
      kitOk ? `${PASS} ${dim(config.kitRoot)}` : bad(`${red("not found")} ${config.kitRoot}`),
    );
    if (kitOk) {
      const migrations = coreMigrations(config.kitRoot);
      field("core migrations", `${migrations.length} ${dim(migrations.at(-1) ?? "")}`);
      const deps = existsSync(join(config.kitRoot, "node_modules", "tsx"));
      field("kit deps", deps ? PASS : `${yellow("not installed")} ${dim("(installed on demand)")}`);
    }
  }

  info("");
  if (problems === 0) ok("Ready to deploy.");
  else warn(`${problems} problem(s) to fix first.`);
  return problems;
}
