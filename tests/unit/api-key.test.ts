import { describe, expect, it } from "vitest";
import {
  deriveApiKeyPrefix,
  generateApiKey,
  hashApiKey,
  looksLikeApiKey,
} from "@/lib/api-auth/api-key";

/**
 * Unit coverage for the API key codec. Pure crypto — no DB, no env.
 */
describe("api-key codec", () => {
  it("generates a key with the documented format", () => {
    const { plaintext, prefix } = generateApiKey("live");
    expect(plaintext.startsWith("drk_live_")).toBe(true);
    expect(prefix.startsWith("drk_live_")).toBe(true);
    // prefix is the tag + first 8 random chars; shorter than the full key.
    expect(prefix.length).toBeLessThan(plaintext.length);
    expect(plaintext.startsWith(prefix)).toBe(true);
  });

  it("uses the test tag when requested", () => {
    expect(generateApiKey("test").plaintext.startsWith("drk_test_")).toBe(true);
  });

  it("produces unique keys", () => {
    const a = generateApiKey("live").plaintext;
    const b = generateApiKey("live").plaintext;
    expect(a).not.toBe(b);
  });

  it("recognizes our keys via looksLikeApiKey", () => {
    expect(looksLikeApiKey("drk_live_abc")).toBe(true);
    expect(looksLikeApiKey("eyJhbGciOi.test.sig")).toBe(false);
    expect(looksLikeApiKey("random")).toBe(false);
  });

  it("derives the display prefix from a plaintext", () => {
    const { plaintext, prefix } = generateApiKey("live");
    expect(deriveApiKeyPrefix(plaintext)).toBe(prefix);
  });

  it("hashes deterministically and differs per key", async () => {
    const k = generateApiKey("live").plaintext;
    const h1 = await hashApiKey(k);
    const h2 = await hashApiKey(k);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    const other = await hashApiKey(generateApiKey("live").plaintext);
    expect(other).not.toBe(h1);
  });
});
