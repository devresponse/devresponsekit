import { db } from "@/db/database";

export const dynamic = "force-dynamic";

export default async function AdminAuditPage() {
  const events = await db
    .selectFrom("app_audit_events")
    .select(["id", "event_type", "outcome", "email", "created_at"])
    .orderBy("created_at", "desc")
    .limit(100)
    .execute();

  return (
    <section className="space-y-4 p-6">
      <h1 className="text-lg font-semibold">Audit log</h1>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-neutral-500">
            <th className="px-2 py-1">Time</th>
            <th className="px-2 py-1">Event</th>
            <th className="px-2 py-1">Outcome</th>
            <th className="px-2 py-1">Subject</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id} className="border-shell-border border-t">
              <td className="px-2 py-1">{(e.created_at as unknown as Date).toISOString()}</td>
              <td className="px-2 py-1">{e.event_type}</td>
              <td className="px-2 py-1">{e.outcome}</td>
              <td className="px-2 py-1">{e.email ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
