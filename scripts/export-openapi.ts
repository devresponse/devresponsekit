import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "@/lib/api-auth/openapi";

/**
 * Exports the `/api/v1` OpenAPI 3.1 document to a committed static file
 * (`docs/openapi.json`) so API clients can be generated WITHOUT booting the
 * server. The same `buildOpenApiDocument` powers the live `/api/v1/openapi.json`
 * route, so the static file never describes a different API than the running
 * one — a drift guard test (`tests/unit/openapi-export.test.ts`) keeps them
 * byte-identical.
 *
 *   pnpm openapi:export                 # default server URL
 *   pnpm openapi:export https://my.host # explicit server URL
 *   OPENAPI_BASE_URL=… pnpm openapi:export
 */
export const DEFAULT_BASE_URL = "https://app.devresponse.com";

export function baseUrlFrom(argv: string[]): string {
  return argv[2] || process.env.OPENAPI_BASE_URL || DEFAULT_BASE_URL;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const OUTPUT_FILE = path.join(__dirname, "..", "docs", "openapi.json");

/** Canonical serialized form — 2-space JSON with a trailing newline. */
export function serializeOpenApi(baseUrl: string): string {
  return `${JSON.stringify(buildOpenApiDocument(baseUrl), null, 2)}\n`;
}

async function main() {
  const baseUrl = baseUrlFrom(process.argv);
  await fs.writeFile(OUTPUT_FILE, serializeOpenApi(baseUrl), "utf8");
  console.log(`[openapi] wrote docs/openapi.json (server: ${baseUrl}/api/v1)`);
}

// Only run when invoked directly (not when imported by the drift test).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error("[openapi] FAILED", error);
    process.exit(1);
  });
}
