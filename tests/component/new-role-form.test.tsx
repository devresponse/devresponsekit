// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewRoleForm } from "@/app/[locale]/(secure)/app/administrator/roles/new/_new-role-form";
import { renderWithIntl } from "../helpers/render-with-intl";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh, prefetch: vi.fn() }) }));

const fetchMock = vi.fn();
beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

// Run as an org admin (no org picker) so the test exercises the fields without
// the OrganizationPicker's own data fetching.
// A real org UUID (org admins always have one); the schema validates the
// organizationId against the UUID format.
const ORG_ID = "11111111-1111-4111-8111-111111111111";

function render() {
  return renderWithIntl(
    <NewRoleForm locale="en" showOrgPicker={false} defaultOrganizationId={ORG_ID} />,
  );
}

describe("NewRoleForm", () => {
  it("marks key and name required (description not)", () => {
    render();
    expect(screen.getByRole("textbox", { name: "Key" })).toHaveAttribute("aria-required", "true");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute("aria-required", "true");
    expect(screen.getByRole("textbox", { name: "Description" })).not.toHaveAttribute(
      "aria-required",
    );
  });

  it("shows a field error and marks the key invalid for a bad key", async () => {
    const user = userEvent.setup();
    render();
    await user.type(screen.getByRole("textbox", { name: "Key" }), "bad key!");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Support");
    await user.click(screen.getByRole("button", { name: "Create role" }));

    expect(
      await screen.findByText("Use only letters, numbers, and the characters . _ - :"),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Key" })).toHaveAttribute("aria-invalid", "true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts (with the default org) and navigates on a valid submit", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ status: 201, json: async () => ({ id: "role-7" }) });
    render();
    await user.type(screen.getByRole("textbox", { name: "Key" }), "support");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Support");
    await user.click(screen.getByRole("button", { name: "Create role" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
    expect(body).toMatchObject({ key: "support", name: "Support", organizationId: ORG_ID });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/en/app/administrator/roles/role-7"));
  });
});
