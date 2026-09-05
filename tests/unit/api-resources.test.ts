import { describe, expect, it } from "vitest";
import {
  audienceForResource,
  mcpAudience,
  mcpResourceIdentifier,
  resolveRequestedResource,
  supportedResources,
  v1ResourceIdentifier,
} from "@/lib/api-auth/resources";

/**
 * RFC 8707 resource allow-list for the token endpoint
 * (`src/lib/api-auth/resources.ts`, review #50/#53). The allow-list is
 * derived from the app's own origin and is the single source for the
 * minted `aud`, the audience `/api/mcp` expects, and the discovery metadata.
 */
const BASE = "https://app.example.com";
const ENV = { BETTER_AUTH_URL: BASE, API_JWT_AUDIENCE: "devresponse-api" };

describe("resource identifiers", () => {
  it("derives both identifiers from the origin, trimming trailing slashes", () => {
    expect(v1ResourceIdentifier("https://app.example.com/")).toBe("https://app.example.com/api/v1");
    expect(mcpResourceIdentifier(BASE)).toBe("https://app.example.com/api/mcp");
    expect(supportedResources(BASE)).toEqual([
      "https://app.example.com/api/v1",
      "https://app.example.com/api/mcp",
    ]);
  });

  it("maps v1 to the configured (backward-compatible) audience and MCP to its own identifier", () => {
    expect(audienceForResource("v1", ENV)).toBe("devresponse-api");
    expect(audienceForResource("mcp", ENV)).toBe("https://app.example.com/api/mcp");
    expect(mcpAudience(ENV)).toBe(audienceForResource("mcp", ENV));
  });
});

describe("resolveRequestedResource", () => {
  it("defaults to the v1 API when `resource` is absent or blank (existing clients unchanged)", () => {
    for (const raw of [undefined, "", "   "]) {
      expect(resolveRequestedResource(raw, BASE)).toEqual({
        kind: "v1",
        resource: "https://app.example.com/api/v1",
      });
    }
  });

  it("accepts both allow-listed identifiers, with or without a trailing slash", () => {
    expect(resolveRequestedResource("https://app.example.com/api/mcp", BASE)).toEqual({
      kind: "mcp",
      resource: "https://app.example.com/api/mcp",
    });
    expect(resolveRequestedResource("https://app.example.com/api/mcp/", BASE)?.kind).toBe("mcp");
    expect(resolveRequestedResource(" https://app.example.com/api/v1 ", BASE)?.kind).toBe("v1");
  });

  it("normalises scheme/host case and default ports on BOTH sides", () => {
    expect(resolveRequestedResource("HTTPS://APP.EXAMPLE.COM:443/api/mcp", BASE)?.kind).toBe("mcp");
    // A BETTER_AUTH_URL spelled with a capitalised host still matches, and the
    // returned identifier is the deployment's own spelling.
    expect(
      resolveRequestedResource("https://app.example.com/api/v1", "https://App.Example.com"),
    ).toEqual({
      kind: "v1",
      resource: "https://App.Example.com/api/v1",
    });
  });

  it("rejects everything that is not exactly one of the two identifiers (invalid_target)", () => {
    for (const raw of [
      "https://evil.example.com/api/mcp", // foreign origin
      "http://app.example.com/api/mcp", // wrong scheme
      "https://app.example.com/api/mcp/tools", // sub-path: an identifier is not a prefix
      "https://app.example.com/api", // parent path
      "https://app.example.com/api/v2",
      "https://app.example.com/api/mcp?x=1", // query
      "https://app.example.com/api/mcp?", // empty query
      "https://app.example.com/api/mcp#frag", // fragment (forbidden by RFC 8707 §2)
      "https://app.example.com/api/mcp#",
      "/api/mcp", // relative reference
      "api/mcp",
      "not a url",
      "https://app.example.com.evil.test/api/mcp", // suffix squat
    ]) {
      expect(resolveRequestedResource(raw, BASE), raw).toBeNull();
    }
  });

  it("does not resolve a resource when the base URL itself is unparsable", () => {
    expect(resolveRequestedResource("https://app.example.com/api/mcp", "not-a-url")).toBeNull();
  });
});
