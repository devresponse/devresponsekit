import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

/**
 * GET/POST /api/auth/[...all]
 *
 * Better Auth catch-all route. Owns provider OAuth callbacks, email/password
 * sign-in, sign-up, sign-out, session refresh, and account linking. This
 * route MUST NOT be wrapped with custom auth checks — Better Auth manages
 * the full lifecycle internally and would deadlock otherwise.
 *
 * Cache: never cache. Status codes are determined by Better Auth.
 */
export const { GET, POST } = toNextJsHandler(auth);
