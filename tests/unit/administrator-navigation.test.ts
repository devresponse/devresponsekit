import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ANY_ADMIN_PERMISSION, SUPERUSER_PERMISSIONS } from "@/lib/admin/permissions";
import {
  ADMINISTRATOR_NAV_GROUPS,
  getVisibleAdministratorNavigationGroups,
} from "@/app/[locale]/(secure)/app/administrator/_components/administrator-navigation";

/**
 * The administrator menubar's quick-create actions (F-66). "New organization"
 * was offered to every org admin on the seeded `admin.platform` role, which
 * holds `admin.orgs.create` but not the cross-org reach POST /organizations
 * demands. Its page now `notFound()`s such a caller, and the nav gate must equal
 * the page guard, so the action is SUPERADMIN-only too.
 */
const ADMIN_DIR = join(
  fileURLToPath(new URL("../../src", import.meta.url)),
  "app",
  "[locale]",
  "(secure)",
  "app",
  "administrator",
);

const actionIds = (permissions: ReadonlyArray<string>) =>
  getVisibleAdministratorNavigationGroups(permissions).flatMap((g) => g.actions.map((a) => a.id));

describe("administrator quick-create actions (F-66)", () => {
  it("does not offer New organization to an org admin holding every admin.* key", () => {
    const ids = actionIds([...ANY_ADMIN_PERMISSION]);
    expect(ids).not.toContain("new-organization");
    // The org-scoped create actions stay.
    expect(ids).toEqual(expect.arrayContaining(["new-user", "new-role", "new-group"]));
  });

  it("offers it to a superadmin", () => {
    expect(actionIds([...SUPERUSER_PERMISSIONS])).toContain("new-organization");
  });

  /**
   * Nav/page parity: each action names its destination page's guard key, and
   * is SUPERADMIN-only exactly when that page refuses a caller without cross-org
   * reach. A page that gains or loses that check fails here until the nav
   * follows.
   */
  it.each(ADMINISTRATOR_NAV_GROUPS.flatMap((g) => g.actions))(
    "$id matches its page guard",
    (action) => {
      const page = readFileSync(
        join(ADMIN_DIR, ...action.href.replace("/app/administrator/", "").split("/"), "page.tsx"),
        "utf8",
      );
      const guardKey = /checkAdminPermissionServer\("([^"]+)"\)/.exec(page)?.[1];
      expect(action.requires).toEqual([guardKey]);
      const pageNeedsReach =
        /if \(!(?:hasCrossOrgReach|isSuperadmin)\(guard\.access\)\) \{\s*notFound\(\);/.test(page);
      expect(action.superadminOnly === true).toBe(pageNeedsReach);
    },
  );
});
