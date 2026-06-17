// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewUserForm } from "@/app/[locale]/(secure)/app/administrator/users/new/_new-user-form";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * Component tests for the create-user form — the reference implementation of
 * the app-wide RHF + Zod validation pattern (docs/form-validation.md). Pins:
 *   - required fields are marked (asterisk + aria-required), optional ones aren't,
 *   - an invalid submit shows field-level messages + sets aria-invalid (red border),
 *   - a 409 maps onto the email field (not a generic banner),
 *   - a valid submit posts and navigates.
 */
const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh, prefetch: vi.fn() }),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("NewUserForm", () => {
  it("marks required fields (email, password) and not the optional display name", () => {
    renderWithIntl(<NewUserForm locale="en" />);

    // The asterisk is decorative; requiredness is conveyed via aria-required.
    expect(screen.getByRole("textbox", { name: "Email" })).toHaveAttribute("aria-required", "true");
    expect(screen.getByLabelText(/password/i)).toHaveAttribute("aria-required", "true");
    expect(screen.getByRole("textbox", { name: "Display name" })).not.toHaveAttribute(
      "aria-required",
    );

    // The required legend explains the marker; the visible asterisks are present.
    expect(screen.getByText("indicates a required field")).toBeInTheDocument();
    expect(screen.getAllByText("*").length).toBeGreaterThanOrEqual(2);
  });

  it("shows field-level errors and marks controls invalid on an empty submit", async () => {
    const user = userEvent.setup();
    renderWithIntl(<NewUserForm locale="en" />);

    await user.click(screen.getByRole("button", { name: "Create user" }));

    // Localized, field-level messages from the shared schema's `validation.*` keys.
    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();
    expect(screen.getByText("Password must be at least 8 characters.")).toBeInTheDocument();

    // Invalid controls get aria-invalid (the red border is driven off it).
    expect(screen.getByRole("textbox", { name: "Email" })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/password/i)).toHaveAttribute("aria-invalid", "true");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a 409 onto the email field instead of a generic banner", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ status: 409, json: async () => ({}) });
    renderWithIntl(<NewUserForm locale="en" />);

    await user.type(screen.getByRole("textbox", { name: "Email" }), "ada@example.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: "Create user" }));

    expect(await screen.findByText("That email address is already in use.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Email" })).toHaveAttribute("aria-invalid", "true");
    expect(push).not.toHaveBeenCalled();
  });

  it("posts and navigates to the new user on a valid submit", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ status: 201, json: async () => ({ id: "user-42" }) });
    renderWithIntl(<NewUserForm locale="en" />);

    await user.type(screen.getByRole("textbox", { name: "Email" }), "ada@example.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: "Create user" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
    expect(body).toMatchObject({ email: "ada@example.com", password: "password123", role: "user" });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/en/app/administrator/users/user-42"));
  });
});
