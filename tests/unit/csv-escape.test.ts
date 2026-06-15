import { describe, expect, it } from "vitest";
import { csvEscape } from "@/app/api/administrator/export/[resource]/route";

/**
 * Unit tests for `csvEscape` — RFC-4180 quoting plus spreadsheet
 * formula-injection neutralization (CWE-1236). The admin CSV export carries
 * untrusted data (user-set `display_name`, the request `User-Agent` in
 * audit rows), so a cell beginning with a formula trigger must be imported
 * as literal text rather than executed when an admin opens the file.
 */
describe("csvEscape — RFC-4180 quoting", () => {
  it("passes plain text through unchanged", () => {
    expect(csvEscape("Alice")).toBe("Alice");
    expect(csvEscape("user@example.com")).toBe("user@example.com");
  });

  it("returns empty string for null/undefined/empty", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
    expect(csvEscape("")).toBe("");
  });

  it("quotes and doubles internal quotes / commas / newlines", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('a"b')).toBe('"a""b"');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });

  it("coerces non-strings", () => {
    expect(csvEscape(42)).toBe("42");
    expect(csvEscape(true)).toBe("true");
  });
});

describe("csvEscape — formula-injection neutralization", () => {
  it("prefixes a single quote when a cell begins with a formula trigger", () => {
    expect(csvEscape("=1+1")).toBe("'=1+1");
    expect(csvEscape("+1")).toBe("'+1");
    expect(csvEscape("-1")).toBe("'-1");
    expect(csvEscape("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvEscape("\tx")).toBe("'\tx");
    // CR is also in the RFC-4180 quote set, so the neutralized value is
    // additionally wrapped: '<CR>x  ->  "'<CR>x"
    expect(csvEscape("\rx")).toBe('"\'\rx"');
  });

  it("neutralizes real attack payloads", () => {
    // user-controlled display_name
    expect(csvEscape('=HYPERLINK("http://evil","click")')).toBe(
      '"\'=HYPERLINK(""http://evil"",""click"")"',
    );
    // classic DDE payload
    expect(csvEscape("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
  });

  it("neutralizes AND quotes when the cell also contains a separator", () => {
    // guard char goes inside the quoted field
    expect(csvEscape("=a,b")).toBe('"\'=a,b"');
  });

  it("does NOT touch a trigger char that is not at the start", () => {
    expect(csvEscape("a=b")).toBe("a=b");
    expect(csvEscape("total: -5")).toBe("total: -5");
    expect(csvEscape("x@y")).toBe("x@y");
  });
});
