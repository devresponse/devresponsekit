import { z } from "zod";

/**
 * Shared validation schemas for the auth forms (docs/form-validation.md).
 * These forms call the Better Auth client directly (no app route), so the
 * schemas are form-only. Error messages are stable `validation.*` i18n keys.
 */

/** Sign-in: any non-empty password (Better Auth verifies it). */
export const signInSchema = z.object({
  email: z.email("email"),
  password: z.string().min(1, "required"),
});
export type SignInInput = z.input<typeof signInSchema>;

/** Sign-up: a real new password (min length applies). */
export const signUpSchema = z.object({
  name: z.string().trim().min(1, "required").max(200, "max"),
  email: z.email("email"),
  password: z.string().min(8, "passwordMin").max(128, "passwordMax"),
});
export type SignUpInput = z.input<typeof signUpSchema>;

/** Forgot password: just an email to send the reset link to. */
export const forgotPasswordSchema = z.object({
  email: z.email("email"),
});
export type ForgotPasswordInput = z.input<typeof forgotPasswordSchema>;

/**
 * Reset password: new + confirm. The base object drives the required markers;
 * the refined schema adds the match check (surfaced on the confirm field).
 */
export const resetPasswordFieldsSchema = z.object({
  password: z.string().min(8, "passwordMin").max(128, "passwordMax"),
  confirmPassword: z.string().min(1, "required"),
});
export const resetPasswordSchema = resetPasswordFieldsSchema.refine(
  (d) => d.password === d.confirmPassword,
  { message: "passwordsMismatch", path: ["confirmPassword"] },
);
export type ResetPasswordInput = z.input<typeof resetPasswordFieldsSchema>;
