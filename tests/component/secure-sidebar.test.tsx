// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SecureSidebar } from "@/app/[locale]/(secure)/_components/secure-sidebar";
import { renderWithIntl } from "../helpers/render-with-intl";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("SecureSidebar", () => {
  it("renders an empty list and skips the fetch when permissions are empty", async () => {
    renderWithIntl(<SecureSidebar locale="en" permissions={[]} />);
    // No skeleton, no error, no fetch.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders the menu items returned by the API", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          menuId: "shell-menu:primary",
          kind: "shell-menu",
          locale: "en",
          generatedAt: "x",
          items: [
            { id: "dashboard", label: "Dashboard", href: "/en/app/dashboard" },
            { id: "workspace", label: "Workspace", href: "/en/app/workspace" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    renderWithIntl(<SecureSidebar locale="en" permissions={["shell.view"]} />);
    expect(await screen.findByRole("link", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Workspace" })).toBeInTheDocument();
  });

  it("renders allow-listed icons aria-hidden, with the label as the accessible name", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          menuId: "shell-menu:primary",
          kind: "shell-menu",
          locale: "en",
          generatedAt: "x",
          items: [
            {
              id: "dashboard",
              label: "Dashboard",
              href: "/en/app/dashboard",
              icon: "layout-dashboard",
            },
            {
              id: "mystery",
              label: "Mystery",
              href: "/en/app/mystery",
              icon: "not-a-known-icon",
            },
            { id: "plain", label: "Plain", href: "/en/app/plain" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    renderWithIntl(<SecureSidebar locale="en" permissions={["shell.view"]} />);

    // Known icon name renders an svg inside the link; it is decorative
    // (aria-hidden) so the accessible name stays the text label.
    const dashboard = await screen.findByRole("link", { name: "Dashboard" });
    expect(dashboard.querySelector("svg")).not.toBeNull();
    expect(dashboard.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");

    // Unknown icon name falls back to the generic glyph (still an svg)
    // rather than collapsing the icon slot.
    const mystery = screen.getByRole("link", { name: "Mystery" });
    expect(mystery.querySelector("svg")).not.toBeNull();

    // No icon field -> no svg at all.
    const plain = screen.getByRole("link", { name: "Plain" });
    expect(plain.querySelector("svg")).toBeNull();
  });

  it("renders a translated unauthorized message + retry on 403", async () => {
    fetchMock.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    renderWithIntl(<SecureSidebar locale="en" permissions={["shell.view"]} />);
    expect(await screen.findByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("retries the fetch when the retry button is clicked", async () => {
    fetchMock.mockResolvedValueOnce(new Response("err", { status: 500 })).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          menuId: "shell-menu:primary",
          kind: "shell-menu",
          locale: "en",
          generatedAt: "x",
          items: [{ id: "dashboard", label: "Dashboard", href: "/en/app/dashboard" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    renderWithIntl(<SecureSidebar locale="en" permissions={["shell.view"]} />);
    const retry = await screen.findByRole("button", { name: /retry/i });
    await userEvent.setup().click(retry);
    expect(await screen.findByRole("link", { name: "Dashboard" })).toBeInTheDocument();
  });
});
