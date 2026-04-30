import { Skeleton } from "@/components/ui/skeleton";

/**
 * WorkspaceLoading
 *
 * Streaming skeleton shown while workspace data resolves. Uses a stable
 * height so the nested `ApplicationShell` layout does not shift.
 */
export default function WorkspaceLoading() {
  return (
    <section className="space-y-4 p-6" aria-busy="true" aria-label="Loading workspace">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-4 w-80" />
      <Skeleton className="h-64 rounded-lg" />
    </section>
  );
}
