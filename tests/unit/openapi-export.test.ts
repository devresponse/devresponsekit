import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { DEFAULT_BASE_URL, OUTPUT_FILE, serializeOpenApi } from "../../scripts/export-openapi";

/**
 * Drift guard: the committed `docs/openapi.json` must stay byte-identical to
 * what `buildOpenApiDocument` produces (the same builder serves the live
 * `/api/v1/openapi.json`). If this fails, the API surface changed without the
 * static spec being regenerated — run `pnpm openapi:export` and commit.
 */
describe("committed OpenAPI document", () => {
  it("is in sync with the builder (run `pnpm openapi:export` after API changes)", async () => {
    const committed = await fs.readFile(OUTPUT_FILE, "utf8");
    expect(committed).toBe(serializeOpenApi(DEFAULT_BASE_URL));
  });

  it("parses as JSON and is an OpenAPI 3.1 document", async () => {
    const doc = JSON.parse(await fs.readFile(OUTPUT_FILE, "utf8")) as { openapi: string };
    expect(doc.openapi).toBe("3.1.0");
  });
});
