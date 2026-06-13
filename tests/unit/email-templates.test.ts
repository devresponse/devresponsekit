import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMAIL_TEMPLATES,
  escapeHtml,
  getDefaultEmailTemplate,
  renderEmailTemplate,
} from "@/lib/email/templates";

/**
 * Unit tests for the email template catalog + renderer (specs.md §35).
 * The renderer's HTML-escaping contract is security-relevant: variable
 * values (display names, emails) are user-controlled and must never
 * inject markup into a template.
 */
describe("renderEmailTemplate", () => {
  it("substitutes {{variable}} placeholders, with and without inner whitespace", () => {
    expect(renderEmailTemplate("Hi {{name}} / {{ name }}!", { name: "Ada" }, "text")).toBe(
      "Hi Ada / Ada!",
    );
  });

  it("HTML-escapes variable VALUES in html mode", () => {
    const out = renderEmailTemplate(
      "<p>Hi {{name}}</p>",
      { name: '<img src=x onerror=alert(1)>"&' },
      "html",
    );
    expect(out).toBe("<p>Hi &lt;img src=x onerror=alert(1)&gt;&quot;&amp;</p>");
  });

  it("does not escape values in text mode", () => {
    expect(renderEmailTemplate("{{v}}", { v: "a & b <c>" }, "text")).toBe("a & b <c>");
  });

  it("keeps URLs usable inside href after escaping", () => {
    const url = "http://localhost:3000/en/reset-password?token=abc123";
    const out = renderEmailTemplate('<a href="{{resetUrl}}">x</a>', { resetUrl: url }, "html");
    expect(out).toBe(`<a href="${url}">x</a>`);
  });

  it("leaves unknown placeholders verbatim so template typos stay visible", () => {
    expect(renderEmailTemplate("Hi {{typo}}", { name: "Ada" }, "text")).toBe("Hi {{typo}}");
  });
});

describe("escapeHtml", () => {
  it("escapes all five sensitive characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("DEFAULT_EMAIL_TEMPLATES", () => {
  it("includes the keys the flows send against", () => {
    expect(getDefaultEmailTemplate("password_reset")).toBeDefined();
    expect(getDefaultEmailTemplate("test_email")).toBeDefined();
    expect(getDefaultEmailTemplate("nope")).toBeUndefined();
  });

  it("every declared variable appears in the template bodies", () => {
    for (const template of DEFAULT_EMAIL_TEMPLATES) {
      for (const variable of template.variables) {
        const everywhere = template.subject + template.bodyHtml + template.bodyText;
        expect(everywhere, `${template.key} should reference {{${variable}}}`).toContain(
          `{{${variable}}}`,
        );
      }
    }
  });

  it("no template body references an undeclared variable", () => {
    for (const template of DEFAULT_EMAIL_TEMPLATES) {
      const everywhere = template.subject + template.bodyHtml + template.bodyText;
      const referenced = [...everywhere.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)].map(
        (m) => m[1],
      );
      for (const name of referenced) {
        expect(template.variables, `${template.key} references undeclared {{${name}}}`).toContain(
          name,
        );
      }
    }
  });
});
