"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * AuthErrorAlert
 *
 * Client Component that renders an error alert for authentication failures.
 * Used by `SignInForm` and `SignUpForm` to surface transient errors such as
 * invalid credentials without a full page reload.
 *
 * Security: the `message` prop must only receive safe, translated strings —
 * never raw server error payloads that could contain sensitive data.
 *
 * Accessibility: `role="alert"` causes screen readers to announce the
 * message immediately when it appears.
 */
export function AuthErrorAlert({ message }: { message: string }) {
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>Error</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
