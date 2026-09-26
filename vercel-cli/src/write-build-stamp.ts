import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeBuildStamp } from "./lib/build-stamp.js";

/**
 * The last step of `pnpm build` (I-14): records which source `dist/` was
 * built from, so the CLI can refuse to run a build that a `git pull` left
 * behind. It runs only after `tsc` succeeds, so a build that does not
 * typecheck leaves the previous stamp, which no longer matches, and is
 * refused too. See `src/lib/build-stamp.ts`.
 */
writeBuildStamp(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
