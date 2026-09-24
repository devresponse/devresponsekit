import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { isEmailVerificationWaived } from "@/lib/auth-verification-waiver";
import {
  USER_NAME_MAX_LENGTH,
  checkUserName,
  sanitizeUserName,
  type UserNameProblem,
} from "@/lib/user-name";

/**
 * F-21: Better Auth's side of the name rule in `src/lib/user-name.ts`.
 *
 * Two layers, because the two kinds of writer need different answers:
 *
 *   1. {@link userNameGuard}, a `before` hook on the endpoints that take a
 *      name from the person making the request (`/sign-up/email`,
 *      `/update-user`). A name that breaks the rule gets a 400 with the code
 *      {@link INVALID_NAME_CODE}, and an accepted one is replaced in the body
 *      by its stored spelling. The check has to run HERE, before the
 *      endpoint: Better Auth creates the user (and runs the database hook)
 *      only for a NEW address, while an existing one gets a synthetic
 *      200 built from the body. Refusing in the database hook alone would
 *      answer a bad name with 400 for a new address and 200 for an existing
 *      one, which F-20 closed. For the same reason the synthetic user must be
 *      built from the stored spelling, so the body is rewritten.
 *   2. {@link boundedUserName}, called from the `user.create.before` and
 *      `user.update.before` database hooks in `src/lib/auth.ts`. Every write
 *      to the `user` row goes through Better Auth's internal adapter, and so
 *      through those hooks: sign-up, `/update-user`, the admin wrappers
 *      (`createBetterAuthUser` calls the admin plugin's endpoint, the others
 *      call `internalAdapter.updateUser`), the bearer branch of
 *      `PATCH /api/account/profile`, and an OAuth sign-in that creates a user
 *      or refreshes its profile. That hook SANITIZES and never refuses: a
 *      provider's display name is not something the person can fix, and
 *      refusing it would break their sign-in. The app's own routes refuse
 *      earlier, with their shared zod schemas (`userNameSchema`), so an
 *      admin or API caller also gets a 400 rather than a changed name.
 */

/** Better Auth error code for a refused name (a 400). */
export const INVALID_NAME_CODE = "INVALID_NAME";

/** Endpoints whose body carries a name the caller chose. */
export const USER_NAME_INPUT_PATHS: readonly string[] = ["/sign-up/email", "/update-user"];

const PROBLEM_MESSAGES: Record<UserNameProblem | "type", string> = {
  type: "Name must be a string",
  required: "Name is required",
  max: `Name must be at most ${USER_NAME_MAX_LENGTH} characters`,
  nameCharacters: "Name must not contain control, line-break or invisible formatting characters",
};

function invalidName(problem: UserNameProblem | "type"): APIError {
  return new APIError("BAD_REQUEST", {
    code: INVALID_NAME_CODE,
    message: PROBLEM_MESSAGES[problem],
  });
}

interface NameHookContext {
  path?: string;
}

/** True for a call to one of {@link USER_NAME_INPUT_PATHS} (HTTP or `auth.api`). */
export function isUserNameInputCall(ctx: NameHookContext): boolean {
  return typeof ctx.path === "string" && USER_NAME_INPUT_PATHS.includes(ctx.path);
}

/**
 * Refuses a name that breaks the rule and replaces an accepted one with its
 * stored spelling (see the module doc). A body without `name` passes:
 * `/update-user` may change other fields. `ctx.path` is the endpoint's route
 * pattern, so the match does not depend on how the URL was spelled. It runs
 * for server-side `auth.api.*` calls too, which is how the profile route's
 * cookie branch reaches `/update-user` (closed over HTTP, F-06).
 */
export const userNameGuard = () =>
  ({
    id: "user-name-guard",
    hooks: {
      before: [
        {
          matcher: isUserNameInputCall,
          handler: createAuthMiddleware(async (ctx) => {
            const body: unknown = ctx.body;
            if (!body || typeof body !== "object" || !("name" in body)) return;
            const raw = (body as { name: unknown }).name;
            if (raw === undefined) return;
            // `/update-user` accepts any JSON value for `name`; only a string
            // is a name. (Sign-up's own schema refuses the rest anyway.)
            if (typeof raw !== "string") throw invalidName("type");
            const result = checkUserName(raw);
            if (!result.ok) throw invalidName(result.problem);
            return { context: { body: { ...body, name: result.name } } };
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;

/**
 * The `name` part of a `user` write, bounded for storage; empty when the write
 * does not set a name (`/update-user` passes `name: undefined` when only other
 * fields change, and a ban or role change never has one).
 */
export function boundedUserName(data: Record<string, unknown>): { name?: string } {
  return typeof data.name === "string" ? { name: sanitizeUserName(data.name) } : {};
}

/**
 * The `{{name}}` a password-reset email greets its recipient by.
 *
 * F-21: a name is chosen by whoever created the account, and before the
 * mailbox is proven that may be anyone: sign-up takes any address and any
 * name, so the name was a way to put the caller's text into a signed email to
 * a stranger. So the address stands in until the owner has proven it. The
 * verification email always uses the address (its recipient has proven
 * nothing yet). A policy waiver or an org admin's creation sets
 * `emailVerified` without proof (`emailVerificationWaived`), so those count
 * as unproven too.
 */
export function resetEmailGreetingName(user: {
  email: string;
  name?: string | null;
  emailVerified?: boolean | null;
}): string {
  const proven = user.emailVerified === true && !isEmailVerificationWaived(user);
  return proven && user.name ? user.name : user.email;
}
