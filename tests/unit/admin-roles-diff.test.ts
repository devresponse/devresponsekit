import { describe, expect, it } from "vitest";
import { diffPermissions as diffServer } from "@/lib/admin/roles.server";
import { diffPermissions as diffClient } from "@/lib/admin/roles.client";

/**
 * Unit tests for the pure `diffPermissions` helper used by the dual-list
 * editor (docs/admin-manager.md §8.4) and the role-permissions API
 * handlers' audit metadata.
 *
 * The helper has TWO copies — one in the server-only module
 * (`roles.server.ts`) and a re-implementation in the client-safe module
 * (`roles.client.ts`) — so the editor doesn't drag the Kysely / pg
 * dependency tree into the browser bundle. These tests pin both
 * implementations against the SAME expected behaviour so the two
 * cannot drift.
 */
describe.each([
  ["server", diffServer],
  ["client", diffClient],
] as const)("diffPermissions (%s)", (_label, diff) => {
  it("returns empty arrays when both inputs are equal sets", () => {
    expect(diff(["a", "b"], ["b", "a"])).toEqual({ toAdd: [], toRemove: [] });
  });

  it("returns empty arrays when both inputs are empty", () => {
    expect(diff([], [])).toEqual({ toAdd: [], toRemove: [] });
  });

  it("ignores duplicates and order — treats inputs as sets", () => {
    const out = diff(["a", "a", "b"], ["b", "c", "c"]);
    expect(out.toAdd).toEqual(["c"]);
    expect(out.toRemove).toEqual(["a"]);
  });

  it("computes adds and removes deterministically (sorted)", () => {
    const out = diff(["alpha"], ["zeta", "alpha", "beta"]);
    expect(out.toAdd).toEqual(["beta", "zeta"]);
    expect(out.toRemove).toEqual([]);
  });

  it("returns adds-only when current is empty", () => {
    expect(diff([], ["x", "y"])).toEqual({ toAdd: ["x", "y"], toRemove: [] });
  });

  it("returns removes-only when next is empty", () => {
    expect(diff(["x", "y"], [])).toEqual({ toAdd: [], toRemove: ["x", "y"] });
  });

  it("does not mutate the input arrays", () => {
    const a = ["a", "b"];
    const b = ["b", "c"];
    const aCopy = [...a];
    const bCopy = [...b];
    diff(a, b);
    expect(a).toEqual(aCopy);
    expect(b).toEqual(bCopy);
  });
});

describe("diffPermissions: server and client implementations agree", () => {
  // Property-style spot check — picking randomized-looking inputs to
  // cover the cases a single hand-written test cannot enumerate. Both
  // helpers are pure so we don't need fast-check; equality of outputs
  // is enough.
  const cases: Array<[string[], string[]]> = [
    [["admin.users.read", "admin.roles.read"], ["admin.users.read"]],
    [["a"], ["a", "b", "c"]],
    [
      ["admin.users.read", "admin.users.update", "admin.roles.read"],
      ["admin.users.read", "admin.roles.read", "admin.roles.create"],
    ],
    [[], ["a"]],
    [["only"], []],
  ];
  for (const [cur, nxt] of cases) {
    it(`agrees for current=[${cur.join(",")}] next=[${nxt.join(",")}]`, () => {
      expect(diffServer(cur, nxt)).toEqual(diffClient(cur, nxt));
    });
  }
});
