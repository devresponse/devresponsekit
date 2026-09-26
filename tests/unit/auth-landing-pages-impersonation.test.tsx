import { describe, expect, it, vi } from "vitest";

/**
 * F-148 — /blocked and /pending-approval must offer an IMPERSONATING admin the
 * way back to their own session.
 *
 * The Stop control lives in `ImpersonationBanner`, which only the `(secure)`
 * layout rendered. These two pages sit outside that group, and they are where
 * `requireSecureSession` sends a borrowed session the shell does not admit: a
 * target blocked or left without an active membership while the admin is using
 * it, or an impersonator whose own reach shrank to nothing. Their panels offer
 * only Sign out, which ends the borrowed session without restoring the admin's,
 * so the admin had to sign in again. Each page now renders the banner itself;
 * the banner renders nothing unless the session carries `impersonatedBy`.
 *
 * The impersonate route refusing such a target up front is pinned in
 * tests/integration/administrator-phase7.test.ts; this covers the session that
 * becomes unusable after it started.
 */
const { BannerStub } = vi.hoisted(() => ({ BannerStub: () => null }));
vi.mock("@/components/admin/impersonation-banner", () => ({ ImpersonationBanner: BannerStub }));

const BlockedPageModule = await import("@/app/[locale]/(auth)/blocked/page");
const PendingPageModule = await import("@/app/[locale]/(auth)/pending-approval/page");
const { BlockedAccountPanel } = await import("@/components/auth/blocked-account-panel");
const { PendingApprovalPanel } = await import("@/components/auth/pending-approval-panel");

/** Every element in the tree whose component is `type`, depth first. */
function findAll(node: unknown, type: unknown): { props: Record<string, unknown> }[] {
  if (!node || typeof node !== "object") return [];
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  const here = el.type === type ? [el as { props: Record<string, unknown> }] : [];
  const children = el.props?.children;
  return [
    ...here,
    ...(Array.isArray(children) ? children : [children]).flatMap((c) => findAll(c, type)),
  ];
}

describe.each([
  ["/blocked", BlockedPageModule, BlockedAccountPanel],
  ["/pending-approval", PendingPageModule, PendingApprovalPanel],
])("%s (F-148)", (_path, pageModule, Panel) => {
  it("renders the impersonation banner, and with it the Stop control", async () => {
    const tree = await pageModule.default({ params: Promise.resolve({ locale: "uk" }) });
    expect(findAll(tree, BannerStub)).toHaveLength(1);
    // The page is otherwise unchanged: its panel, in the requested locale.
    expect(findAll(tree, Panel).map((el) => el.props.locale)).toEqual(["uk"]);
  });

  it("renders per request, because the banner reads the session", () => {
    expect(pageModule.dynamic).toBe("force-dynamic");
  });
});
