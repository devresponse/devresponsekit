import { z } from "zod";

/**
 * F-21 — the one rule for a person's name, shared by the forms, the app's
 * routes and the Better Auth hooks.
 *
 * Better Auth stores `user.name` as given, and before F-21 only the sign-up
 * FORM bounded it (200 characters after trimming). A direct POST to
 * `/api/auth/sign-up/email` could store megabytes, line breaks, or bidi
 * overrides that make text render reversed. That value then went into the
 * signed verification email sent to whatever address the caller named, so
 * anyone could make the platform mail a stranger a lure, and repeat it with
 * `/send-verification-email`.
 *
 * The rule:
 *
 *   - At most {@link USER_NAME_MAX_LENGTH} UTF-16 units (the unit zod's
 *     `.max()` counts) after trimming and collapsing whitespace. 200 is the
 *     bound the sign-up form and both published create-user contracts
 *     (`CreateUserRequest.name`, `maxLength: 200` in docs/openapi*.json)
 *     already stated, so no existing client breaks. The bound stops the
 *     megabyte case; greeting by the address instead of an unproven name
 *     (src/lib/auth.ts) is what stops the lure.
 *   - None of the {@link FORBIDDEN_CHARACTER} characters: C0/C1 controls
 *     (`\t`, `\r`, `\n`, NUL, DEL, NEL, ...), lone surrogates, the line and
 *     paragraph separators, the bidi embedding, override and isolate controls
 *     plus the three direction marks (the "Trojan Source" set, CVE-2021-42574),
 *     and the zero-width space, word joiner and BOM, which only hide text.
 *     ZWNJ and ZWJ (U+200C, U+200D) are allowed: Hindi and other scripts need
 *     them, and so do emoji sequences.
 *   - Unicode NFC, and every run of whitespace becomes one space, so two
 *     spellings of the same name are stored the same way. The one exception
 *     is a single ideographic space (U+3000), which Japanese and Chinese
 *     input methods type between family and given name: it is kept as typed.
 *
 * Two ways to apply it:
 *
 *   - {@link checkUserName} for a name somebody TYPED (sign-up, the profile
 *     form, the admin forms and APIs): a name that breaks the rule is refused
 *     with a reason, not silently changed.
 *   - {@link sanitizeUserName} for a name nobody can correct: an OAuth
 *     provider's profile, where refusing would break sign-in, and the database
 *     hook that backs up every writer. It drops what the rule forbids and
 *     truncates, and never fails.
 *
 * For any name `checkUserName` accepts, `sanitizeUserName` returns the same
 * value (pinned by a property test), so both paths store one spelling.
 *
 * Pure and client-safe: the zod schemas below are imported by client forms.
 */

/** Maximum stored length of a person's name, in UTF-16 units (see module doc). */
export const USER_NAME_MAX_LENGTH = 200;

/** A character a stored name never contains (see module doc). */
const FORBIDDEN_CHARACTER =
  /[\p{Cc}\p{Cs}\u061C\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u;
const FORBIDDEN_CHARACTERS = new RegExp(FORBIDDEN_CHARACTER.source, "gu");

/** The same set `String.prototype.trim` removes (WhiteSpace + LineTerminator). */
const WHITESPACE_RUN = /\s+/gu;

/**
 * U+3000 IDEOGRAPHIC SPACE: what a Japanese or Chinese input method types for
 * the space key, often between family and given name. A single one is part of
 * how the name was written, so it is kept as typed rather than rewritten to a
 * half-width space.
 */
const IDEOGRAPHIC_SPACE = "\u3000";

/**
 * The one space a whitespace run is stored as: a lone ideographic space stays,
 * and anything else (NBSP, the other width variants, a line break in a name
 * being sanitized, or a run of two or more) becomes U+0020.
 */
function spaceFor(run: string): string {
  return run === IDEOGRAPHIC_SPACE ? run : " ";
}

/** Why a typed name was refused. Each value is a `validation.*` message key. */
export type UserNameProblem = "required" | "max" | "nameCharacters";

export type UserNameCheck = { ok: true; name: string } | { ok: false; problem: UserNameProblem };

/** NFC, one space per whitespace run (see {@link spaceFor}), trimmed. */
function canonicalize(value: string): string {
  return value.normalize("NFC").replace(WHITESPACE_RUN, spaceFor).trim();
}

/**
 * Checks a name somebody typed. Surrounding whitespace is ignored, as the
 * forms' `.trim()` always did, so a pasted trailing newline is not an error;
 * a line break or bidi control INSIDE the name is.
 */
export function checkUserName(raw: string): UserNameCheck {
  const trimmed = raw.trim();
  if (FORBIDDEN_CHARACTER.test(trimmed)) return { ok: false, problem: "nameCharacters" };
  const name = canonicalize(trimmed);
  if (name === "") return { ok: false, problem: "required" };
  if (name.length > USER_NAME_MAX_LENGTH) return { ok: false, problem: "max" };
  return { ok: true, name };
}

/**
 * Makes any string a storable name: whitespace (line breaks included) becomes
 * a space, the other forbidden characters are dropped, and the result is cut
 * to {@link USER_NAME_MAX_LENGTH} on a code-point boundary, so a surrogate
 * pair is never split. May return `""` when nothing printable is left; the
 * caller decides what an empty name means.
 */
export function sanitizeUserName(raw: string): string {
  const name = canonicalize(
    raw.replace(WHITESPACE_RUN, spaceFor).replace(FORBIDDEN_CHARACTERS, ""),
  );
  if (name.length <= USER_NAME_MAX_LENGTH) return name;
  let cut = "";
  for (const codePoint of name) {
    if (cut.length + codePoint.length > USER_NAME_MAX_LENGTH) break;
    cut += codePoint;
  }
  return cut.trimEnd();
}

function toUserName(value: string, ctx: z.RefinementCtx<string>): string {
  const result = checkUserName(value);
  if (result.ok) return result.name;
  ctx.addIssue({ code: "custom", message: result.problem });
  return z.NEVER;
}

/**
 * A required name field. Parses to the stored spelling (`checkUserName`'s
 * `name`), so a route writes exactly what Better Auth's hooks would store.
 */
export const userNameSchema = z.string().transform(toUserName);

/**
 * An optional name field where blank means "no name" (parses to `""`), as on
 * the admin create-user form. Anything else must pass the same rule.
 */
export const optionalUserNameSchema = z
  .string()
  .transform((value, ctx) => (value.trim() === "" ? "" : toUserName(value, ctx)));
