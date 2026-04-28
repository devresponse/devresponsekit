import type { NextRequest } from "next/server";
import { applyAdminStatusAction } from "@/lib/admin-status.server";

export const dynamic = "force-dynamic";

/** POST /api/admin/users/block — sets the target user to `blocked`. */
export async function POST(request: NextRequest) {
  return applyAdminStatusAction({
    request,
    newStatus: "blocked",
    newMembershipStatus: "blocked",
    eventOverride: "admin.user.blocked",
  });
}
