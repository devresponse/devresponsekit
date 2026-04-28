import type { NextRequest } from "next/server";
import { applyAdminStatusAction } from "@/lib/admin-status.server";

export const dynamic = "force-dynamic";

/** POST /api/admin/users/approve — sets the target user to `active`. */
export async function POST(request: NextRequest) {
  return applyAdminStatusAction({
    request,
    newStatus: "active",
    newMembershipStatus: "active",
    eventOverride: "admin.user.approved",
  });
}
