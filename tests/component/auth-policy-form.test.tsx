// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthPolicyForm } from "@/components/admin/auth-policy-form";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * Component tests for the signup-policy editor (0007). Pins the two-mode
 * behavior (inherit summary ⇄ override form), the form→API body
 * conversion, and the reset (DELETE) flow.
 */
const fetchMock = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ENDPOINT = "/api/administrator/organizations/org-1/auth-settings";

// A valid open-signup override (auto-active, no verification). Domains are
// null: verification-off + auto-approve-domains is a rejected combination
// (the security refine), so this fixture must not encode it.
const OVERRIDE = {
  requireEmailVerification: false,
  signupApprovalMode: "auto_active" as const,
  allowedAuthMethods: null,
  autoApproveEmailDomains: null,
};

describe("AuthPolicyForm", () => {
  it("shows the inherit summary (no form) when the org has no override", () => {
    renderWithIntl(
      <AuthPolicyForm
        endpoint={ENDPOINT}
        scope="organization"
        initialSettings={null}
        platformDefaults={{
          requireEmailVerification: true,
          signupApprovalMode: "admin_approval",
          allowedAuthMethods: null,
          autoApproveEmailDomains: null,
        }}
        canUpdate
      />,
    );
    expect(screen.getByText(/inherits the platform sign-up defaults/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /customize/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save policy/i })).not.toBeInTheDocument();
  });

  it("hides the customize CTA without update permission", () => {
    renderWithIntl(
      <AuthPolicyForm
        endpoint={ENDPOINT}
        scope="organization"
        initialSettings={null}
        platformDefaults={null}
        canUpdate={false}
      />,
    );
    expect(screen.queryByRole("button", { name: /customize/i })).not.toBeInTheDocument();
  });

  it("opens the form pre-filled from the platform defaults and PATCHes the converted body", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const user = userEvent.setup();
    renderWithIntl(
      <AuthPolicyForm
        endpoint={ENDPOINT}
        scope="organization"
        initialSettings={null}
        platformDefaults={{
          requireEmailVerification: true,
          signupApprovalMode: "admin_approval",
          allowedAuthMethods: null,
          autoApproveEmailDomains: null,
        }}
        canUpdate
      />,
    );

    await user.click(screen.getByRole("button", { name: /customize/i }));
    const verification = screen.getByRole("checkbox", { name: /require email verification/i });
    expect(verification).toBeChecked();

    await user.type(
      screen.getByRole("textbox", { name: /auto-approve email domains/i }),
      "Acme.com, acme.com",
    );
    await user.click(screen.getByRole("button", { name: /save policy/i }));

    expect(fetchMock).toHaveBeenCalledWith(ENDPOINT, expect.objectContaining({ method: "PATCH" }));
    const [, patchInit] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse((patchInit as { body: string }).body) as Record<string, unknown>;
    expect(body).toEqual({
      requireEmailVerification: true,
      signupApprovalMode: "admin_approval",
      allowedAuthMethods: null,
      autoApproveEmailDomains: ["acme.com"],
    });
    expect(await screen.findByRole("status")).toHaveTextContent(/updated/i);
  });

  it("rejects an invalid domain list client-side without calling the API", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <AuthPolicyForm
        endpoint={ENDPOINT}
        scope="organization"
        initialSettings={OVERRIDE}
        platformDefaults={null}
        canUpdate
      />,
    );

    const domains = screen.getByRole("textbox", { name: /auto-approve email domains/i });
    await user.clear(domains);
    await user.type(domains, "not a domain");
    await user.click(screen.getByRole("button", { name: /save policy/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/valid domains separated by commas/i)).toBeInTheDocument();
  });

  it("warns about open signup when auto-active is combined with no verification", () => {
    renderWithIntl(
      <AuthPolicyForm
        endpoint={ENDPOINT}
        scope="organization"
        initialSettings={OVERRIDE}
        platformDefaults={null}
        canUpdate
      />,
    );
    expect(screen.getByText(/immediate access without proving/i)).toBeInTheDocument();
  });

  it("resets to inheritance via DELETE and returns to the summary view", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const user = userEvent.setup();
    renderWithIntl(
      <AuthPolicyForm
        endpoint={ENDPOINT}
        scope="organization"
        initialSettings={OVERRIDE}
        platformDefaults={{
          requireEmailVerification: false,
          signupApprovalMode: "auto_active",
          allowedAuthMethods: null,
          autoApproveEmailDomains: null,
        }}
        canUpdate
      />,
    );

    await user.click(screen.getByRole("button", { name: /reset to platform defaults/i }));

    expect(fetchMock).toHaveBeenCalledWith(ENDPOINT, expect.objectContaining({ method: "DELETE" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/inherits/i);
    expect(screen.queryByRole("button", { name: /save policy/i })).not.toBeInTheDocument();
    // The disclosed default is what the summary shows — not the strict baseline.
    expect(screen.getByText("Active immediately")).toBeInTheDocument();
  });

  /**
   * Review #72 follow-up. #72 stopped streaming the platform defaults to a
   * non-superadmin whose org has its own override, so `platformDefaults` is
   * legitimately null — and Reset is the ONLY way into the inherit view while
   * that is true (the button renders only when `scope === "organization"` and
   * the org has a row). Falling back to STRICT_DEFAULTS therefore told an org
   * admin "email verification required / admin approval" as the policy now in
   * effect, whatever the platform default actually is: on this repo's own
   * seeded DB it is `auto_active` with no verification, i.e. the summary was
   * wrong in the permissive→strict direction on the page whose job is to
   * report the live sign-up policy.
   */
  it("does NOT substitute the strict baseline when the platform defaults are withheld", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const user = userEvent.setup();
    renderWithIntl(
      <AuthPolicyForm
        endpoint={ENDPOINT}
        scope="organization"
        initialSettings={OVERRIDE}
        platformDefaults={null}
        canUpdate
      />,
    );

    await user.click(screen.getByRole("button", { name: /reset to platform defaults/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(/inherits/i);

    // The summary is replaced by an explicit "not shown" statement: no
    // verification/approval claim of any kind is made.
    expect(screen.getByText(/only a platform superadmin can view it/i)).toBeInTheDocument();
    expect(screen.queryByText("Administrator approval required")).not.toBeInTheDocument();
    expect(screen.queryByText("Email verification")).not.toBeInTheDocument();
  });

  it("asks the RSC to re-run after a reset, so the real inherited policy can load", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const user = userEvent.setup();
    renderWithIntl(
      <AuthPolicyForm
        endpoint={ENDPOINT}
        scope="organization"
        initialSettings={OVERRIDE}
        platformDefaults={null}
        canUpdate
      />,
    );

    await user.click(screen.getByRole("button", { name: /reset to platform defaults/i }));
    await screen.findByRole("status");
    // With the override gone the page may load the platform default again;
    // without this the withheld state persists until a manual reload.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("still pre-fills Customize from the fail-closed baseline when defaults are withheld", async () => {
    // A form the admin is about to fill in may start strict — nothing is
    // saved until Save, so it states nothing about the platform default.
    const user = userEvent.setup();
    renderWithIntl(
      <AuthPolicyForm
        endpoint={ENDPOINT}
        scope="organization"
        initialSettings={null}
        platformDefaults={null}
        canUpdate
      />,
    );
    await user.click(screen.getByRole("button", { name: /customize/i }));
    expect(screen.getByRole("checkbox", { name: /require email verification/i })).toBeChecked();
  });

  it("platform scope always edits and never offers reset", () => {
    renderWithIntl(
      <AuthPolicyForm
        endpoint="/api/administrator/auth-settings/defaults"
        scope="platform"
        initialSettings={OVERRIDE}
        canUpdate
      />,
    );
    expect(screen.getByRole("button", { name: /save policy/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /reset to platform defaults/i }),
    ).not.toBeInTheDocument();
  });

  it("labels an inherited invite_only policy correctly in the summary (0008)", () => {
    renderWithIntl(
      <AuthPolicyForm
        endpoint={ENDPOINT}
        scope="organization"
        initialSettings={null}
        platformDefaults={{
          requireEmailVerification: true,
          signupApprovalMode: "invite_only",
          allowedAuthMethods: null,
          autoApproveEmailDomains: null,
        }}
        canUpdate
      />,
    );
    expect(screen.getByText("Invitation required")).toBeInTheDocument();
  });
});
