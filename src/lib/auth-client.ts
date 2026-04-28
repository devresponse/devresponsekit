"use client";

import { createAuthClient } from "better-auth/react";

/**
 * Browser auth client.
 *
 * Tokens are managed by Better Auth via HTTP-only cookies. Do not persist
 * any auth-related state in client stores; the `authClient` is only used
 * to invoke sign-in / sign-up / sign-out actions and to read the current
 * session through Better Auth's reactive helpers.
 */
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL,
});
