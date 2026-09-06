import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAdminOpenApiDocument } from "@/lib/api-auth/openapi-admin";
import {
  API_DOC_FILE,
  extractAdminApiTable,
  renderAdminApiTable,
  replaceAdminApiTable,
  TABLE_END,
  TABLE_START,
} from "../../scripts/admin-api-table";

/**
 * docs/api.md §6 resource table ⇄ admin OpenAPI document (review #198). The
 * hand-written table claimed `GET/PATCH/DELETE …/api-keys/[id]` while the
 * route (and spec, and SDK) only ever had GET and DELETE. The table is now
 * GENERATED from the spec by `pnpm docs:admin-table`; this test fails when
 * the committed markdown and the spec disagree, so the fix is always
 * "re-run the script", never "edit the table by hand".
 */
const doc = buildAdminOpenApiDocument("https://app.devresponse.com");
const rendered = renderAdminApiTable(doc);

describe("docs/api.md administrator table is generated from the spec (#198)", () => {
  it("the committed block equals what the spec renders (run `pnpm docs:admin-table`)", () => {
    const markdown = readFileSync(API_DOC_FILE, "utf8");
    expect(extractAdminApiTable(markdown)).toBe(rendered);
  });

  it("the API keys row lists GET/DELETE on …/[id] — the drift the finding caught", () => {
    const row = rendered.split("\n").find((line) => line.startsWith("| API keys |"))!;
    expect(row).toContain("`GET/DELETE /api-keys/[id]`");
    expect(row).not.toContain("PATCH /api-keys/[id]");
  });

  it("covers every tag in spec order, with its x-permissions summary", () => {
    const tags = (doc as { tags: Array<{ name: string; "x-permissions": string }> }).tags;
    const rows = rendered.split("\n").slice(2);
    expect(rows.map((r) => r.split(" | ")[0]!.replace("| ", ""))).toEqual(tags.map((t) => t.name));
    for (const tag of tags) {
      const row = rows.find((r) => r.startsWith(`| ${tag.name} |`))!;
      expect(row.endsWith(`| ${tag["x-permissions"]} |`)).toBe(true);
    }
  });

  it("prints every documented path exactly once, in [param] style", () => {
    const paths = Object.keys((doc as { paths: Record<string, unknown> }).paths);
    for (const p of paths) {
      const printed = p.replace(/\{(\w+)\}/g, "[$1]");
      const occurrences = rendered.split(` ${printed}\``).length - 1;
      expect(occurrences, printed).toBe(1);
    }
    expect(rendered).not.toContain("{id}");
  });

  it("replaceAdminApiTable swaps only the block between the markers", () => {
    const before = `intro\n${TABLE_START}\nold\n${TABLE_END}\noutro\n`;
    expect(replaceAdminApiTable(before, "new")).toBe(
      `intro\n${TABLE_START}\nnew\n${TABLE_END}\noutro\n`,
    );
    expect(() => replaceAdminApiTable("no markers", "x")).toThrow(/markers/);
    expect(extractAdminApiTable("no markers")).toBeNull();
  });
});
