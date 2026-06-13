"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

/**
 * Root error boundary — the last resort for errors thrown in the root
 * layout itself, *outside* the locale + i18n providers. It must render
 * its own `<html>`/`<body>`, so it cannot use `next-intl` and is
 * intentionally minimal and English-only. The localized, in-shell
 * fallback lives in `(secure)/app/error.tsx`.
 *
 * Still captures to Sentry (no-op when disabled) so even a catastrophic
 * boot/layout error is observable.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, -apple-system, sans-serif",
          display: "flex",
          minHeight: "100vh",
          alignItems: "center",
          justifyContent: "center",
          margin: 0,
        }}
      >
        <div style={{ maxWidth: 420, padding: 24, textAlign: "center" }}>
          <h1 style={{ fontSize: 18, marginBottom: 8 }}>Something went wrong</h1>
          <p style={{ color: "#666", fontSize: 14, marginBottom: 12 }}>
            An unexpected error occurred. Please reload the page.
          </p>
          {error.digest ? (
            <p style={{ color: "#888", fontSize: 12, marginBottom: 12 }}>
              Reference: <code>{error.digest}</code>
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ padding: "6px 14px", cursor: "pointer" }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
