// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApplicationSwitcherSheet } from "@/components/app-shell/application-switcher-sheet";
import { renderWithIntl } from "../helpers/render-with-intl";
import { makeApplicationsMenuResponse } from "../helpers/test-data-factories";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ApplicationSwitcherSheet", () => {
  it("renders the trigger with an accessible name", () => {
    renderWithIntl(<ApplicationSwitcherSheet locale="en" />);
    expect(screen.getByRole("button", { name: /switch application/i })).toBeInTheDocument();
  });

  it("loads applications when the sheet opens and renders SSO launch links", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(makeApplicationsMenuResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const user = userEvent.setup();
    renderWithIntl(<ApplicationSwitcherSheet locale="en" />);
    await user.click(screen.getByRole("button", { name: /switch application/i }));

    const link = await screen.findByRole("link", { name: /portal/i });
    expect(link).toHaveAttribute("href", "/api/sso/launch?applicationId=portal&locale=en");
    // Defence in depth: links carry rel="nofollow noreferrer" so the
    // SSO launch URL is not leaked through Referer headers.
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("renders a translated unauthorized message when the API returns 403", async () => {
    fetchMock.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));

    const user = userEvent.setup();
    renderWithIntl(<ApplicationSwitcherSheet locale="en" />);
    await user.click(screen.getByRole("button", { name: /switch application/i }));

    await waitFor(() => {
      expect(screen.getByText(/permission/i)).toBeInTheDocument();
    });
    // A retry button is offered (§25 skeleton + retry pattern).
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("renders the empty-state message when the API returns no applications", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(makeApplicationsMenuResponse([])), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const user = userEvent.setup();
    renderWithIntl(<ApplicationSwitcherSheet locale="en" />);
    await user.click(screen.getByRole("button", { name: /switch application/i }));

    expect(await screen.findByText(/no applications/i)).toBeInTheDocument();
  });
});
