// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewApiKeyForm } from "@/app/[locale]/(secure)/app/administrator/api-keys/new/_new-api-key-form";
import { renderWithIntl } from "../helpers/render-with-intl";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh, prefetch: vi.fn() }) }));

const fetchMock = vi.fn();
const SCOPES = ["api.read", "api.write"];
const OWNER = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const render = () => renderWithIntl(<NewApiKeyForm locale="en" scopeCatalog={SCOPES} />);

describe("NewApiKeyForm", () => {
  it("marks name and owner required (not expiry)", () => {
    render();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute("aria-required", "true");
    expect(screen.getByRole("textbox", { name: /owner/i })).toHaveAttribute(
      "aria-required",
      "true",
    );
    expect(screen.getByRole("spinbutton", { name: /expires/i })).not.toHaveAttribute(
      "aria-required",
    );
  });

  it("blocks submit and marks name + owner invalid when empty", async () => {
    const user = userEvent.setup();
    render();
    await user.click(screen.getByRole("button", { name: "Issue key" }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute("aria-invalid", "true"),
    );
    expect(screen.getByRole("textbox", { name: /owner/i })).toHaveAttribute("aria-invalid", "true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a 404 onto the owner field", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ status: 404, json: async () => ({}) });
    render();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "CI key");
    await user.type(screen.getByRole("textbox", { name: /owner/i }), OWNER);
    await user.click(screen.getByRole("button", { name: "Issue key" }));

    expect(
      await screen.findByText("No user found with that application user ID."),
    ).toBeInTheDocument();
  });

  it("maps a 422 ungrantable-scopes onto the scopes group", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({
      status: 422,
      json: async () => ({ ungrantableScopes: ["api.write"] }),
    });
    render();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "CI key");
    await user.type(screen.getByRole("textbox", { name: /owner/i }), OWNER);
    await user.click(screen.getByRole("checkbox", { name: "api.write" }));
    await user.click(screen.getByRole("button", { name: "Issue key" }));

    expect(
      await screen.findByText("The owner does not hold these scopes: api.write"),
    ).toBeInTheDocument();
  });

  it("posts the chosen scopes on a valid submit", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ status: 201, json: async () => ({ key: "secret-key" }) });
    render();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "CI key");
    await user.type(screen.getByRole("textbox", { name: /owner/i }), OWNER);
    await user.click(screen.getByRole("checkbox", { name: "api.read" }));
    await user.click(screen.getByRole("button", { name: "Issue key" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
    expect(body).toMatchObject({ name: "CI key", ownerAppUserId: OWNER, scopes: ["api.read"] });
  });
});
