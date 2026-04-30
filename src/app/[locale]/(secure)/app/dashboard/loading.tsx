import { Skeleton } from "@/components/ui/skeleton";

/**
 * DashboardLoading
 *
 * Streaming skeleton shown while the dashboard page data resolves.
 * Uses a stable height so the sidebar layout does not shift when
 * the page content arrives.
 */
export default function DashboardLoading() {
  return (
    <section className="space-y-4 p-6" aria-busy="true" aria-label="Loading dashboard">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-96" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-32 rounded-lg" />
        <Skeleton className="h-32 rounded-lg" />
        <Skeleton className="h-32 rounded-lg" />
      </div>
    </section>
  );
}
