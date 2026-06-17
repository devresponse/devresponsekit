// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateEditForm } from "@/app/[locale]/(secure)/app/administrator/email/templates/[templateId]/_template-edit-form";
import { renderWithIntl } from "../helpers/render-with-intl";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh, prefetch: vi.fn() }) }));

const fetchMock = vi.fn();
const TEMPLATE = {
  id: "t1",
  subject: "Welcome",
  body_html: "<p>Hello {{name}}</p>",
  body_text: null,
  description: null,
};

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const render = () =>
  renderWithIntl(<TemplateEditForm locale="en" template={TEMPLATE} knownVariables={["name"]} />);

describe("TemplateEditForm", () => {
  it("marks subject and HTML body required (not the text body / description)", () => {
    render();
    expect(screen.getByRole("textbox", { name: "Subject" })).toHaveAttribute(
      "aria-required",
      "true",
    );
    expect(screen.getByRole("textbox", { name: "HTML body" })).toHaveAttribute(
      "aria-required",
      "true",
    );
    expect(screen.getByRole("textbox", { name: "Text body" })).not.toHaveAttribute("aria-required");
    expect(screen.getByRole("textbox", { name: "Description" })).not.toHaveAttribute(
      "aria-required",
    );
  });

  it("blocks the save when the subject is emptied", async () => {
    const user = userEvent.setup();
    render();
    await user.clear(screen.getByRole("textbox", { name: "Subject" }));
    await user.click(screen.getByRole("button", { name: "Save template" }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Subject" })).toHaveAttribute(
        "aria-invalid",
        "true",
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PUTs and navigates to the list on success", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    render();
    await user.type(screen.getByRole("textbox", { name: "Subject" }), "!");
    await user.click(screen.getByRole("button", { name: "Save template" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/administrator/email/templates/t1",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith("/en/app/administrator/email/templates"));
  });
});
