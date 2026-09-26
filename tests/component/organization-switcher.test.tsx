// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Component, type ReactNode } from "react";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OrganizationSwitcher } from "@/components/app-shell/organization-switcher";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * F-68: switching the active organization must rebuild EVERY layer of the
 * shell, not just the server components. `router.refresh()` left the
 * client-fetched, org-scoped views (the primary sidebar menu, each admin
 * DataGrid's rows and bulk selection) on the previous org, so the switch is a
 * full reload now. A failed switch, network error included, leaves the page
 * on the current org rather than reaching an error boundary.
 */
const fetchMock = vi.fn();
const reloadMock = vi.fn();
const refreshMock = vi.fn();

// The switcher must not lean on the RSC refresh; the mock lets a regression to
// `router.refresh()` render (and be caught) instead of throwing on a missing
// app-router context.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

const ORGS = [
  { id: "org-a", slug: "org-a", name: "ORG A" },
  { id: "org-b", slug: "org-b", name: "ORG B" },
];

/** Stands in for the route error boundary above the secure layout. */
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <p>boundary fallback</p> : this.props.children;
  }
}

beforeEach(() => {
  fetchMock.mockReset();
  reloadMock.mockReset();
  refreshMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", { ...window.location, reload: reloadMock });
});
afterEach(() => vi.unstubAllGlobals());

async function choose(name: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: /organization/i }));
  const listbox = await screen.findByRole("listbox");
  await user.click(within(listbox).getByText(name));
}

function renderSwitcher() {
  return renderWithIntl(
    <Boundary>
      <OrganizationSwitcher current="org-a" organizations={ORGS} />
    </Boundary>,
  );
}

describe("OrganizationSwitcher (F-68)", () => {
  it("posts the chosen org, then reloads the page instead of an RSC refresh", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    renderSwitcher();
    await choose("ORG B");

    await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/preferences/active-org",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ organizationId: "org-b" }),
      }),
    );
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("does not reload when the switch is refused", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    renderSwitcher();
    await choose("ORG B");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: /organization/i })).toBeEnabled(),
    );
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("treats a network failure as a failed switch, not an error-boundary crash", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    renderSwitcher();
    await choose("ORG B");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // The switcher is still there, re-enabled on the current org.
    const trigger = await screen.findByRole("combobox", { name: /organization/i });
    await waitFor(() => expect(trigger).toBeEnabled());
    expect(trigger).toHaveTextContent("ORG A");
    expect(screen.queryByText("boundary fallback")).toBeNull();
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("ignores choosing the org that is already active", async () => {
    renderSwitcher();
    await choose("ORG A");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
  });
});
