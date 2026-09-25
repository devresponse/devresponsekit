// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  saveDualListDiff,
  useDualListSave,
  type DualListEndpoint,
} from "@/lib/admin/dual-list-save.client";

/**
 * F-38: the shared dual-list save, below the two editors that use it
 * (tests/component/dual-list-editors.test.tsx drives them end to end). These
 * pin the branches the editors cannot reach through their UI: a network error,
 * a re-read that fails after a clean save, and a second save issued before
 * React has re-rendered the disabled button.
 */
const fetchMock = vi.fn();

const endpoint: DualListEndpoint = {
  url: "/api/x",
  bodyKey: "ids",
  readAssigned: (body) => (body as { ids: string[] }).ids,
};

function jsonRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("saveDualListDiff", () => {
  it("sends only the non-empty writes, POST first, each with the endpoint's body key", async () => {
    fetchMock.mockResolvedValue(jsonRes({ ids: ["b", "c"] }));
    const result = await saveDualListDiff(endpoint, ["a", "b"], ["c", "b"]);

    expect(fetchMock.mock.calls.map(([, init]) => (init as { method?: string }).method)).toEqual([
      "POST",
      "DELETE",
      undefined,
    ]);
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body)).toEqual({
      ids: ["c"],
    });
    expect(JSON.parse((fetchMock.mock.calls[1]![1] as { body: string }).body)).toEqual({
      ids: ["a"],
    });
    expect(result).toEqual({ error: null, synced: ["b", "c"] });
  });

  it("stops at a refused POST: the DELETE is never sent, and the server is re-read", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) =>
      init?.method === "POST" ? jsonRes({ error: "forbidden" }, 403) : jsonRes({ ids: ["a"] }),
    );
    expect(await saveDualListDiff(endpoint, ["a"], ["b"])).toEqual({
      error: "forbidden",
      synced: ["a"],
    });
    expect(fetchMock.mock.calls.map(([, init]) => (init as { method?: string }).method)).toEqual([
      "POST",
      undefined,
    ]);
  });

  it("adopts the saved set when every write landed but the re-read failed", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) =>
      init?.method ? jsonRes({ ok: true }) : jsonRes({}, 500),
    );
    expect(await saveDualListDiff(endpoint, ["a"], ["c", "b"])).toEqual({
      error: null,
      synced: ["b", "c"],
    });
  });

  it("reports a network error as `failed` and still re-reads the server", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) => {
      if (init?.method) throw new TypeError("network down");
      return jsonRes({ ids: ["a"] });
    });
    expect(await saveDualListDiff(endpoint, ["a"], ["b"])).toEqual({
      error: "failed",
      synced: ["a"],
    });
  });

  it("returns `synced: null` when a write failed and the re-read threw too", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) => {
      if (init?.method) return jsonRes({}, 500);
      throw new TypeError("network down");
    });
    expect(await saveDualListDiff(endpoint, ["a"], ["b"])).toEqual({
      error: "failed",
      synced: null,
    });
  });

  it("treats a 409 whose body cannot be parsed as a plain failure", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) => {
      if (init?.method) {
        return {
          ok: false,
          status: 409,
          json: async () => {
            throw new SyntaxError("not json");
          },
        };
      }
      return jsonRes({ ids: ["a"] });
    });
    expect((await saveDualListDiff(endpoint, ["a"], [])).error).toBe("failed");
  });
});

describe("useDualListSave", () => {
  it("resolves a second save issued while one is in flight to null, sending nothing", async () => {
    let release = () => {};
    fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) => {
      if (init?.method === "DELETE") await new Promise<void>((r) => (release = r));
      return jsonRes({ ids: [] });
    });
    const { result } = renderHook(() => useDualListSave(endpoint));

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = result.current.save(["a"], []);
      second = result.current.save(["a"], []);
    });
    expect(await second).toBeNull();
    expect(result.current.saving).toBe(true);

    await act(async () => {
      release();
      await first;
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    expect(result.current.saving).toBe(false);
    expect(result.current.stale).toBe(false);
  });

  it("goes stale once a save fails and the server cannot be re-read", async () => {
    fetchMock.mockResolvedValue(jsonRes({}, 500));
    const { result } = renderHook(() => useDualListSave(endpoint));

    await act(async () => {
      await result.current.save(["a"], []);
    });
    expect(result.current.stale).toBe(true);
  });
});
