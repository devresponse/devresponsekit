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

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ENDPOINT = "/api/administrator/organizations/org-1/auth-settings";

const OVERRIDE = {
  requireEmailVerification: false,
  signupApprovalMode: "auto_active" as const,
  allowedAuthMethods: null,
  autoApproveEmailDomains: ["acme.com"],
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
        platformDefaults={null}
        canUpdate
      />,
    );

    await user.click(screen.getByRole("button", { name: /reset to platform defaults/i }));

    expect(fetchMock).toHaveBeenCalledWith(ENDPOINT, expect.objectContaining({ method: "DELETE" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/inherits/i);
    expect(screen.queryByRole("button", { name: /save policy/i })).not.toBeInTheDocument();
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
});
