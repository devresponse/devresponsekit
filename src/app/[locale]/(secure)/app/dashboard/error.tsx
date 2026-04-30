"use client";

/**
 * DashboardError
 *
 * Error boundary for the dashboard route segment. Displayed when an
 * unhandled error is thrown inside the dashboard page or its children.
 *
 * Per Next.js convention, error boundaries must be Client Components.
 * The component offers a retry action that re-invokes the segment render.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="space-y-4 p-6" role="alert">
      <h2 className="text-lg font-semibold text-destructive">
        Something went wrong loading the dashboard.
      </h2>
      {/* Do not expose the raw error message to the user in production. */}
      {process.env.NODE_ENV !== "production" && (
        <pre className="rounded bg-neutral-100 p-3 text-xs text-neutral-700">
          {error.message}
        </pre>
      )}
      <button
        onClick={reset}
        className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
      >
        Retry
      </button>
    </section>
  );
}
