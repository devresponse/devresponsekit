import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPathInsideRoot,
  isSafeSegment,
  resolveAssetFile,
  resolveDocFile,
  splitSlug,
} from "@/lib/docs/safe-path.server";

const NUL = String.fromCharCode(0);
const SOH = String.fromCharCode(1);

/**
 * Path-safety is the security boundary of the docs viewer: the slug is
 * untrusted URL input that becomes a filesystem path. These tests pin the
 * pure validators and exercise the resolvers against the real repo
 * `docs/` folder (the default root when `DOCS_ROOT` is unset).
 */
describe("isSafeSegment", () => {
  it("accepts plain file/dir names", () => {
    expect(isSafeSegment("get-started")).toBe(true);
    expect(isSafeSegment("setup_email")).toBe(true);
    expect(isSafeSegment("a1.md")).toBe(true);
  });

  it("rejects empty, dot, and dot-dot", () => {
    expect(isSafeSegment("")).toBe(false);
    expect(isSafeSegment(".")).toBe(false);
    expect(isSafeSegment("..")).toBe(false);
  });

  it("rejects dotfiles", () => {
    expect(isSafeSegment(".git")).toBe(false);
    expect(isSafeSegment(".env")).toBe(false);
  });

  it("rejects separators, drive markers, and control characters", () => {
    expect(isSafeSegment("a/b")).toBe(false);
    expect(isSafeSegment("a\\b")).toBe(false);
    expect(isSafeSegment("c:")).toBe(false);
    expect(isSafeSegment(`a${NUL}b`)).toBe(false);
    expect(isSafeSegment(`a${SOH}b`)).toBe(false);
  });
});

describe("splitSlug", () => {
  it("splits clean slugs and tolerates extra slashes", () => {
    expect(splitSlug("a/b")).toEqual(["a", "b"]);
    expect(splitSlug("/a//b/")).toEqual(["a", "b"]);
    expect(splitSlug(["a", "b"])).toEqual(["a", "b"]);
  });

  it("rejects traversal in raw and percent-encoded form", () => {
    expect(splitSlug("../secret")).toBeNull();
    expect(splitSlug("a/../b")).toBeNull();
    expect(splitSlug("%2e%2e/secret")).toBeNull();
    expect(splitSlug("a/%2e%2e/b")).toBeNull();
  });

  it("rejects malformed percent-encoding and empty input", () => {
    expect(splitSlug("%zz")).toBeNull();
    expect(splitSlug("")).toBeNull();
    expect(splitSlug("/")).toBeNull();
  });
});

describe("isPathInsideRoot", () => {
  const root = path.resolve("some-root");

  it("accepts the root itself and descendants", () => {
    expect(isPathInsideRoot(root, root)).toBe(true);
    expect(isPathInsideRoot(root, path.join(root, "a", "b.md"))).toBe(true);
  });

  it("rejects siblings and traversal escapes", () => {
    expect(isPathInsideRoot(root, path.resolve("other-root"))).toBe(false);
    expect(isPathInsideRoot(root, path.join(root, "..", "escape"))).toBe(false);
  });
});

describe("resolveDocFile (against the repo docs root)", () => {
  it("resolves an existing document by slug", async () => {
    const resolved = await resolveDocFile("get-started");
    expect(resolved).not.toBeNull();
    expect(resolved!.slug).toBe("get-started");
    expect(resolved!.format).toBe("md");
    expect(resolved!.absPath.endsWith("get-started.md")).toBe(true);
  });

  it("returns null for traversal, dotfiles, and misses", async () => {
    expect(await resolveDocFile("../package")).toBeNull();
    expect(await resolveDocFile("../../etc/passwd")).toBeNull();
    expect(await resolveDocFile(".env")).toBeNull();
    expect(await resolveDocFile("definitely-not-a-doc")).toBeNull();
  });
});

describe("resolveAssetFile (against the repo docs root)", () => {
  it("rejects non-image extensions and traversal", async () => {
    // `get-started.md` exists but is not an image → rejected.
    expect(await resolveAssetFile("get-started.md")).toBeNull();
    expect(await resolveAssetFile("../package.json")).toBeNull();
    expect(await resolveAssetFile("nope.png")).toBeNull();
  });
});
