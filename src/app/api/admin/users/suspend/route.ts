import type { NextRequest } from "next/server";
import { applyAdminStatusAction } from "@/lib/admin-status.server";

export const dynamic = "force-dynamic";

/** POST /api/admin/users/suspend — sets the target user to `suspended`. */
export async function POST(request: NextRequest) {
  return applyAdminStatusAction({
    request,
    newStatus: "suspended",
    newMembershipStatus: "suspended",
    eventOverride: "admin.user.suspended",
  });
}
