"use client";

import type { ReactNode } from "react";
import { ThemeProvider } from "./theme-provider";

/**
 * AppProviders
 *
 * Client Component that wraps the application tree with all global
 * React context providers. Kept in one place so the provider order is
 * deterministic and easy to audit.
 *
 * Why a Client Component: React context providers must render on the
 * client. Server Components can still be rendered inside this wrapper —
 * only the provider boundary itself is client-side.
 *
 * Currently includes:
 *   - ThemeProvider (next-themes) for light/dark mode support.
 *
 * Do NOT add auth context here — auth state lives in Better Auth and
 * is read server-side. Do NOT add Zustand stores here — stores are
 * imported directly by client components that need them.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}
