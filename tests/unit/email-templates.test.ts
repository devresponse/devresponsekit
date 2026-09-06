import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMAIL_TEMPLATES,
  escapeHtml,
  getDefaultEmailTemplate,
  renderEmailTemplate,
} from "@/lib/email/templates";
import { defaultLocale, locales } from "@/config/i18n-config";

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

  /**
   * review #78: lookup was `variables[name]`, which resolves INHERITED
   * `Object.prototype` members. A template row an org admin can edit could
   * therefore reach `escapeHtml` with a function (`{{constructor}}`) — which
   * has no `.replaceAll`, so the send THREW before the outbox insert and took
   * the flow (e.g. password reset) with it — or render engine internals into
   * a real email (`{{toString}}`).
   */
  describe("prototype-chain placeholders (review #78)", () => {
    const inherited = ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"];

    for (const name of inherited) {
      it(`leaves {{${name}}} verbatim instead of resolving the inherited member`, () => {
        for (const mode of ["text", "html"] as const) {
          const out = renderEmailTemplate(`x {{${name}}} y`, { name: "Ada" }, mode);
          expect(out).toBe(`x {{${name}}} y`);
        }
      });
    }

    it("does not throw when every inherited member is referenced at once", () => {
      const template = inherited.map((n) => `{{${n}}}`).join(" ");
      expect(() => renderEmailTemplate(template, {}, "html")).not.toThrow();
    });

    it("still resolves an OWN property that shadows an inherited name", () => {
      const vars = { toString: "shadowed" } as unknown as Record<string, string>;
      expect(renderEmailTemplate("{{toString}}", vars, "text")).toBe("shadowed");
    });

    it("ignores an own property whose value is not a string", () => {
      const vars = { n: 42 } as unknown as Record<string, string>;
      expect(renderEmailTemplate("{{n}}", vars, "html")).toBe("{{n}}");
    });
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

describe("localized templates (P3-8)", () => {
  // Derived from the supported-locale list rather than hard-coded (review
  // #110): `translations` is an untyped Record, so a locale added to
  // i18n-config.ts with no email translations would otherwise pass silently.
  const LOCALES = locales.filter((l) => l !== defaultLocale);

  it("overlays the requested locale's content, falling back to en for unknown locales", () => {
    const en = getDefaultEmailTemplate("password_reset", "en");
    const fr = getDefaultEmailTemplate("password_reset", "fr");
    expect(fr?.subject).toBeDefined();
    expect(fr?.subject).not.toBe(en?.subject); // fr overlay applied
    // An unsupported locale degrades to the en base rather than failing.
    expect(getDefaultEmailTemplate("password_reset", "de")?.subject).toBe(en?.subject);
    // Default arg is en.
    expect(getDefaultEmailTemplate("password_reset")?.subject).toBe(en?.subject);
  });

  it("ships every supported non-en locale for every template", () => {
    for (const t of DEFAULT_EMAIL_TEMPLATES) {
      for (const locale of LOCALES) {
        expect(
          t.translations?.[locale],
          `${t.key} is missing the ${locale} translation`,
        ).toBeDefined();
      }
    }
  });

  it("every translation preserves the declared variables (e.g. fr reset keeps {{resetUrl}})", () => {
    for (const t of DEFAULT_EMAIL_TEMPLATES) {
      for (const locale of LOCALES) {
        const localized = getDefaultEmailTemplate(t.key, locale)!;
        const everywhere = localized.subject + localized.bodyHtml + localized.bodyText;
        for (const variable of t.variables) {
          expect(everywhere, `${t.key}/${locale} should keep {{${variable}}}`).toContain(
            `{{${variable}}}`,
          );
        }
      }
    }
  });

  it("no translation references an undeclared variable", () => {
    for (const t of DEFAULT_EMAIL_TEMPLATES) {
      for (const locale of LOCALES) {
        const localized = getDefaultEmailTemplate(t.key, locale)!;
        const everywhere = localized.subject + localized.bodyHtml + localized.bodyText;
        const referenced = [...everywhere.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)].map(
          (m) => m[1],
        );
        for (const name of referenced) {
          expect(t.variables, `${t.key}/${locale} references undeclared {{${name}}}`).toContain(
            name,
          );
        }
      }
    }
  });
});
