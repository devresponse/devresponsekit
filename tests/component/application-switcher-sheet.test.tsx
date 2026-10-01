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

    // F-118: announced, since the list fails after the sheet opened.
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/permission/i);
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

/**
 * NAVK: the "Administration Console" entry. The secure layout decides the gate
 * server-side and passes only `adminConsoleHref`; the sheet puts the entry
 * first, outside the fetched list, so the list's loading, error and empty
 * states never hide it.
 */
describe("ApplicationSwitcherSheet — Administration Console entry (NAVK)", () => {
  const HREF = "/en/app/administrator";
  const consoleLink = () => screen.getByRole("link", { name: /administration console/i });

  async function openSheet(adminConsoleHref?: string) {
    const user = userEvent.setup();
    renderWithIntl(<ApplicationSwitcherSheet locale="en" adminConsoleHref={adminConsoleHref} />);
    await user.click(screen.getByRole("button", { name: /switch application/i }));
    return user;
  }

  it("is the first link, above the loaded applications, with its description", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(makeApplicationsMenuResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await openSheet(HREF);

    await screen.findByRole("link", { name: /portal/i });
    const links = screen.getAllByRole("link");
    expect(links[0]).toBe(consoleLink());
    expect(links[0]).toHaveAttribute("href", HREF);
    expect(links[0]).toHaveTextContent(/manage users, organizations, roles and settings/i);
  });

  it("shows while the applications are still loading", async () => {
    fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));
    await openSheet(HREF);

    expect(consoleLink()).toHaveAttribute("href", HREF);
    expect(screen.queryByRole("link", { name: /portal/i })).not.toBeInTheDocument();
  });

  it("shows when the applications fail to load", async () => {
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    await openSheet(HREF);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(consoleLink()).toHaveAttribute("href", HREF);
  });

  it("shows when the caller has no applications", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(makeApplicationsMenuResponse([])), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await openSheet(HREF);

    expect(await screen.findByText(/no applications/i)).toBeInTheDocument();
    expect(consoleLink()).toHaveAttribute("href", HREF);
  });

  it("closes the sheet when clicked", async () => {
    fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));
    const user = await openSheet(HREF);

    const link = consoleLink();
    // jsdom cannot navigate; the default action is not what this pins.
    link.addEventListener("click", (event) => event.preventDefault());
    await user.click(link);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("is absent without adminConsoleHref", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(makeApplicationsMenuResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await openSheet();

    await screen.findByRole("link", { name: /portal/i });
    expect(screen.queryByRole("link", { name: /administration console/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});
