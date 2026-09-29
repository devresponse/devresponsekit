import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMAIL_TEMPLATES,
  escapeHtml,
  getDefaultEmailTemplate,
  renderEmailTemplate,
} from "@/lib/email/templates";
import { defaultLocale, locales } from "@/config/i18n-config";
import { INVITATION_TTL_MS } from "@/lib/token-ttls";

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

/** One row a `locales/*.sql` migration seeds into `app_email_templates`. */
interface SeededTemplateRow {
  key: string;
  locale: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
}

type SqlToken = { kind: "string" | "word"; value: string };

/**
 * Splits a seed file into string literals and words, skipping whitespace and
 * `--` comments. Literals are read as Postgres reads them with
 * `standard_conforming_strings` on: `'…'` doubles a quote and takes a
 * backslash literally; `E'…'` also takes the backslash escapes the seed files
 * use. Anything else throws, so a file in a shape this does not know fails
 * the test instead of being read wrong.
 */
function tokenizeSql(source: string): SqlToken[] {
  const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", "\\": "\\", "'": "'" };
  const tokens: SqlToken[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i++;
    } else if (source.startsWith("--", i)) {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end + 1;
    } else if (ch === "'" || (/[Ee]/.test(ch) && source[i + 1] === "'")) {
      const extended = ch !== "'";
      i += extended ? 2 : 1;
      let value = "";
      for (;;) {
        const c = source[i];
        if (c === undefined) throw new Error("unterminated string literal");
        if (c === "'" && source[i + 1] === "'") {
          value += "'";
          i += 2;
        } else if (c === "'") {
          i++;
          break;
        } else if (extended && c === "\\") {
          const escaped = escapes[source[i + 1] ?? ""];
          if (escaped === undefined) throw new Error(`unsupported escape at ${i}`);
          value += escaped;
          i += 2;
        } else {
          value += c;
          i++;
        }
      }
      tokens.push({ kind: "string", value });
    } else if (/[A-Za-z_]/.test(ch)) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i))![0];
      tokens.push({ kind: "word", value: word.toLowerCase() });
      i += word.length;
    } else if ("(),;".includes(ch)) {
      tokens.push({ kind: "word", value: ch });
      i++;
    } else {
      throw new Error(`unexpected ${JSON.stringify(ch)} at ${i}`);
    }
  }
  return tokens;
}

/**
 * The rows of a seed file's one statement, `insert into app_email_templates
 * (key, locale, subject, body_html, body_text, description) values (…), …
 * on conflict (key, locale) do nothing;`. The description is not compared (the
 * SQL copy lists the variables; the code keeps them in `variables`).
 */
function parseSeededTemplates(source: string): SeededTemplateRow[] {
  const tokens = tokenizeSql(source);
  let at = 0;
  const expectWords = (words: string) => {
    for (const word of words.split(" ")) {
      const token = tokens[at++];
      if (token?.kind !== "word" || token.value !== word) {
        throw new Error(`expected "${word}", got ${JSON.stringify(token)}`);
      }
    }
  };
  const nextString = () => {
    const token = tokens[at++];
    if (token?.kind !== "string")
      throw new Error(`expected a literal, got ${JSON.stringify(token)}`);
    return token.value;
  };
  expectWords(
    "insert into app_email_templates ( key , locale , subject , body_html , body_text , description ) values",
  );
  const rows: SeededTemplateRow[] = [];
  for (;;) {
    expectWords("(");
    const [key, locale, subject, bodyHtml, bodyText] = [0, 1, 2, 3, 4].map((n) => {
      if (n > 0) expectWords(",");
      return nextString();
    }) as [string, string, string, string, string];
    expectWords(",");
    nextString(); // description
    expectWords(")");
    rows.push({ key, locale, subject, bodyHtml, bodyText });
    const next = tokens[at];
    if (next?.kind !== "word" || next.value !== ",") break;
    at++;
  }
  expectWords("on conflict ( key , locale ) do nothing ;");
  if (at !== tokens.length) throw new Error("the file holds more than the one insert");
  return rows;
}

/**
 * F-103: the seeded `locales/*.sql` rows and `DEFAULT_EMAIL_TEMPLATES` were
 * kept in sync by a comment, and the fr invitation had drifted: the code copy
 * used typographic apostrophes (`l’invitation`) where the seeded row has
 * straight ones. Only the code copy moved: an applied migration file is
 * checksummed in the ledger.
 */
describe("seeded SQL copies of the templates (F-103)", () => {
  const dir = path.resolve(__dirname, "../../src/db/migrations/locales");
  const seeded = readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .flatMap((file) =>
      parseSeededTemplates(readFileSync(path.join(dir, file), "utf8")).map((row) => ({
        file,
        ...row,
      })),
    );

  it("reads SQL literals the way Postgres does", () => {
    const [row] = parseSeededTemplates(
      "-- a comment\ninsert into app_email_templates (key, locale, subject, body_html, body_text, description) values\n" +
        "  ('k', 'fr', 'l''a', 'a\\n', E'x\\ny''z\\\\', 'd')\non conflict (key, locale) do nothing;",
    );
    // A plain literal keeps its backslash; an E'' literal reads `\n` as a
    // newline and `\\` as one backslash.
    expect(row).toEqual({
      key: "k",
      locale: "fr",
      subject: "l'a",
      bodyHtml: "a\\n",
      bodyText: "x\ny'z\\",
    });
  });

  it("seeds exactly one row per template and supported locale, in that locale's file", () => {
    const expected = DEFAULT_EMAIL_TEMPLATES.flatMap((t) => locales.map((l) => `${t.key}/${l}`));
    expect(seeded.map((r) => `${r.key}/${r.locale}`).sort()).toEqual(expected.sort());
    for (const row of seeded) {
      expect(row.file).toMatch(new RegExp(`^\\d{4}-email-templates-${row.locale}\\.sql$`));
    }
  });

  it("every seeded row's subject and bodies equal the code default, byte for byte", () => {
    for (const row of seeded) {
      const template = getDefaultEmailTemplate(row.key, row.locale)!;
      expect(
        { subject: row.subject, bodyHtml: row.bodyHtml, bodyText: row.bodyText },
        `${row.file}: ${row.key}/${row.locale}`,
      ).toEqual({
        subject: template.subject,
        bodyHtml: template.bodyHtml,
        bodyText: template.bodyText,
      });
    }
  });

  /**
   * The invitation body tells the invitee how long the link lives ("expires in
   * 7 days", in every locale), and so does the admin's invite dialog. That
   * number is `INVITATION_TTL_MS`, which the invitation module stamps and the
   * outbox drain enforces, so a change to it must change the copy too; the
   * parity test above then carries the email's to SQL.
   */
  it("states the invitation TTL the code enforces, in every locale's email and invite dialog", () => {
    const days = INVITATION_TTL_MS / (24 * 60 * 60_000);
    expect(Number.isInteger(days)).toBe(true);
    const stated = new RegExp(`(^|\\D)${days}(\\D|$)`);
    for (const locale of locales) {
      const template = getDefaultEmailTemplate("organization_invitation", locale)!;
      expect(template.bodyHtml, `organization_invitation/${locale} html`).toMatch(stated);
      expect(template.bodyText, `organization_invitation/${locale} text`).toMatch(stated);
      const messages = JSON.parse(
        readFileSync(path.resolve(__dirname, `../../src/messages/${locale}.json`), "utf8"),
      ) as { administrator: { orgs: { invitations: { dialogDescription: string } } } };
      expect(
        messages.administrator.orgs.invitations.dialogDescription,
        `${locale}.json administrator.orgs.invitations.dialogDescription`,
      ).toMatch(stated);
    }
  });
});
