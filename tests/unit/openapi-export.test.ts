import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import {
  ADMIN_OUTPUT_FILE,
  DEFAULT_BASE_URL,
  OUTPUT_FILE,
  serializeAdminOpenApi,
  serializeOpenApi,
} from "../../scripts/export-openapi";

/**
 * Drift guard: the committed OpenAPI documents must stay byte-identical to
 * what their builders produce (the v1 builder also serves the live
 * `/api/v1/openapi.json`; the admin builder is the source for the SDK under
 * `sdk/admin/`). If this fails, an API surface changed without the static
 * spec being regenerated — run `pnpm openapi:export` (and, for the admin
 * surface, `pnpm sdk:admin:generate`) and commit.
 */
describe("committed OpenAPI documents", () => {
  it("docs/openapi.json is in sync with the v1 builder", async () => {
    const committed = await fs.readFile(OUTPUT_FILE, "utf8");
    expect(committed).toBe(serializeOpenApi(DEFAULT_BASE_URL));
  });

  it("docs/openapi-admin.json is in sync with the admin builder", async () => {
    const committed = await fs.readFile(ADMIN_OUTPUT_FILE, "utf8");
    expect(committed).toBe(serializeAdminOpenApi(DEFAULT_BASE_URL));
  });

  it("both parse as JSON and are OpenAPI 3.1 documents", async () => {
    for (const file of [OUTPUT_FILE, ADMIN_OUTPUT_FILE]) {
      const doc = JSON.parse(await fs.readFile(file, "utf8")) as { openapi: string };
      expect(doc.openapi).toBe("3.1.0");
    }
  });
});
