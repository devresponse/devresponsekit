// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewEnterpriseAppForm } from "@/app/[locale]/(secure)/app/administrator/enterprise-apps/new/_new-enterprise-app-form";
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

// Org ids are real UUIDs: the shared schema validates `organization_id`.
const ACME = { id: "11111111-1111-4111-8111-111111111111", slug: "acme" };
const GLOBEX_ID = "22222222-2222-4222-8222-222222222222";
const ORGS = {
  items: [
    { id: ACME.id, slug: "acme", name: "Acme" },
    { id: GLOBEX_ID, slug: "globex", name: "Globex" },
  ],
  total: 2,
};

/** The audience field's own namespace refusal for org `acme` (not the id's). */
const AUDIENCE_REFUSED =
  "Only a superadmin can register an SSO audience outside your organization's slug. The part after the last colon must be an ID under it, normally this application's ID, such as devresponse-app:acme.crm.";

/** Answers the superadmin picker's org search, and the create POST with `post`. */
function stagePost(post: { status: number; json: () => Promise<unknown> }) {
  fetchMock.mockImplementation((url: string) =>
    Promise.resolve(
      String(url).startsWith("/api/administrator/organizations")
        ? { ok: true, status: 200, json: async () => ORGS }
        : post,
    ),
  );
}

function postCalls() {
  return fetchMock.mock.calls.filter(
    (c) => (c[1] as { method?: string } | undefined)?.method === "POST",
  );
}

function postedBody(): Record<string, unknown> {
  const calls = postCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[0]).toBe("/api/administrator/enterprise-apps");
  return JSON.parse((calls[0]?.[1] as { body: string }).body);
}

const renderSuperadmin = () =>
  renderWithIntl(<NewEnterpriseAppForm locale="en" showOrgPicker ownOrganization={null} />);
const renderOrgAdmin = () =>
  renderWithIntl(<NewEnterpriseAppForm locale="en" showOrgPicker={false} ownOrganization={ACME} />);

/** Fills every required field but the id, and the audience with `audience`. */
async function fillRest(user: ReturnType<typeof userEvent.setup>, audience: string) {
  await user.type(screen.getByRole("textbox", { name: "Label" }), "Acme");
  await user.type(screen.getByRole("textbox", { name: "Origin" }), "https://acme.com");
  await user.type(screen.getByRole("textbox", { name: "Subdomain" }), "acme");
  await user.type(screen.getByRole("textbox", { name: "SSO audience" }), audience);
}

async function fillValid(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole("textbox", { name: "ID" }), "acme.app");
  await fillRest(user, "acme:aud");
}

/** Waits for the superadmin picker's org list, so a POST is the next fetch. */
async function pickerLoaded(container: HTMLElement) {
  await waitFor(() =>
    expect(container.querySelector("#enterprise-app-organization")).not.toBeDisabled(),
  );
}

describe("NewEnterpriseAppForm", () => {
  it("marks the required fields and not the optional ones", () => {
    stagePost({ status: 201, json: async () => ({}) });
    renderSuperadmin();
    for (const name of ["ID", "Label", "Origin", "Subdomain", "SSO audience"]) {
      expect(screen.getByRole("textbox", { name })).toHaveAttribute("aria-required", "true");
    }
    expect(screen.getByRole("textbox", { name: "Description" })).not.toHaveAttribute(
      "aria-required",
    );
    expect(screen.getByRole("spinbutton", { name: "Sort order" })).not.toHaveAttribute(
      "aria-required",
    );
  });

  it("blocks submit and marks required controls invalid on an empty submit", async () => {
    const user = userEvent.setup();
    stagePost({ status: 201, json: async () => ({}) });
    renderSuperadmin();
    await user.click(screen.getByRole("button", { name: "Create application" }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "ID" })).toHaveAttribute("aria-invalid", "true"),
    );
    expect(screen.getByRole("textbox", { name: "Origin" })).toHaveAttribute("aria-invalid", "true");
    expect(postCalls()).toHaveLength(0);
  });

  it("maps a server invalid_origin (400) onto the origin field", async () => {
    const user = userEvent.setup();
    stagePost({ status: 400, json: async () => ({ error: "invalid_origin" }) });
    renderSuperadmin();
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Create application" }));

    expect(
      await screen.findByText("Origin must be an HTTPS URL with no path."),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Origin" })).toHaveAttribute("aria-invalid", "true");
    expect(push).not.toHaveBeenCalled();
  });

  it("posts and navigates to the created app on a valid submit", async () => {
    const user = userEvent.setup();
    stagePost({ status: 201, json: async () => ({ id: "acme.app" }) });
    const { container } = renderSuperadmin();
    await pickerLoaded(container);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Create application" }));

    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(postedBody()).toMatchObject({
      id: "acme.app",
      label: "Acme",
      origin: "https://acme.com",
      subdomain: "acme",
      sso_audience: "acme:aud",
      sort_order: 100,
    });
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/en/app/administrator/enterprise-apps/acme.app"),
    );
  });
});

/**
 * R14: the form sent no `organization_id`, so every create was a global app,
 * which the route refuses to an org admin (403): an org admin could not create
 * any app from the console. It now sends the org the page resolved for a
 * confined caller, and a superadmin chooses a global app or an org. App ids and
 * audiences are global names an org admin may claim only under its org's slug
 * (I-01), so its form prefills and hints the prefix and puts the route's 403 on
 * the field outside it.
 */
describe("NewEnterpriseAppForm scope (R14)", () => {
  it("an org admin gets no picker, the id prefilled with its slug, and a hint on both names", () => {
    const { container } = renderOrgAdmin();

    expect(container.querySelector("#enterprise-app-organization")).toBeNull();
    expect(screen.getByRole("textbox", { name: "ID" })).toHaveValue("acme.");
    expect(
      screen.getByText(/start the ID with acme and a dot, for example acme\.crm\./),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/must be an ID under your organization's slug.*\(for example acme\.crm\)/),
    ).toBeInTheDocument();
  });

  it("an org admin posts its own organization_id with a name under its slug", async () => {
    const user = userEvent.setup();
    stagePost({ status: 201, json: async () => ({ id: "acme.crm" }) });
    renderOrgAdmin();
    await user.type(screen.getByRole("textbox", { name: "ID" }), "crm");
    await fillRest(user, "devresponse-app:acme.crm");
    await user.click(screen.getByRole("button", { name: "Create application" }));

    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(postedBody()).toMatchObject({
      id: "acme.crm",
      sso_audience: "devresponse-app:acme.crm",
      organization_id: ACME.id,
    });
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/en/app/administrator/enterprise-apps/acme.crm"),
    );
  });

  it("puts the route's namespace 403 on each name outside the slug, not a generic root error", async () => {
    const user = userEvent.setup();
    stagePost({ status: 403, json: async () => ({ error: "forbidden" }) });
    renderOrgAdmin();
    const id = screen.getByRole("textbox", { name: "ID" });
    await user.clear(id);
    await user.type(id, "crm");
    await fillRest(user, "devresponse-app:crm");
    await user.click(screen.getByRole("button", { name: "Create application" }));

    // Each field states its own rule: the audience is judged by the part after
    // its last colon, so the id's "start with acme." would mislead there.
    expect(
      await screen.findByText(
        "Only a superadmin can register an ID outside your organization's slug. Start it with acme and a dot, then a name, such as acme.crm.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(AUDIENCE_REFUSED)).toBeInTheDocument();
    expect(id).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("textbox", { name: "SSO audience" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(postedBody()).toMatchObject({ id: "crm", organization_id: ACME.id });
    expect(push).not.toHaveBeenCalled();
  });

  it("marks only the audience when the id is under the slug", async () => {
    const user = userEvent.setup();
    stagePost({ status: 403, json: async () => ({ error: "forbidden" }) });
    renderOrgAdmin();
    await user.type(screen.getByRole("textbox", { name: "ID" }), "crm");
    // Starts with `acme.`, but its last segment `crm` is outside the slug.
    await fillRest(user, "acme.portal:crm");
    await user.click(screen.getByRole("button", { name: "Create application" }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "SSO audience" })).toHaveAttribute(
        "aria-invalid",
        "true",
      ),
    );
    expect(screen.getByText(AUDIENCE_REFUSED)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "ID" })).toHaveAttribute("aria-invalid", "false");
  });

  it("tells an org admin who submits the bare prefill that a name must follow the dot", async () => {
    const user = userEvent.setup();
    stagePost({ status: 403, json: async () => ({ error: "forbidden" }) });
    renderOrgAdmin();
    await fillRest(user, "devresponse-app:acme.crm");
    await user.click(screen.getByRole("button", { name: "Create application" }));

    expect(
      await screen.findByText(/Start it with acme and a dot, then a name/),
    ).toBeInTheDocument();
    expect(postedBody()).toMatchObject({ id: "acme." });
    expect(screen.getByRole("textbox", { name: "ID" })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("textbox", { name: "SSO audience" })).toHaveAttribute(
      "aria-invalid",
      "false",
    );
  });

  it("keeps a 403 on names under the slug a root error (e.g. the active org changed)", async () => {
    const user = userEvent.setup();
    stagePost({ status: 403, json: async () => ({ error: "forbidden" }) });
    renderOrgAdmin();
    await user.type(screen.getByRole("textbox", { name: "ID" }), "crm");
    await fillRest(user, "devresponse-app:acme.crm");
    await user.click(screen.getByRole("button", { name: "Create application" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You don't have permission to view this page.",
    );
  });

  it("a superadmin gets the picker, no prefix, and creates a global app by default", async () => {
    const user = userEvent.setup();
    stagePost({ status: 201, json: async () => ({ id: "crm" }) });
    const { container } = renderSuperadmin();
    await pickerLoaded(container);

    expect(container.querySelector("#enterprise-app-organization")).toHaveTextContent(
      "Global (all organizations)",
    );
    const id = screen.getByRole("textbox", { name: "ID" });
    expect(id).toHaveValue("");
    expect(screen.queryByText(/under your organization's slug/)).not.toBeInTheDocument();
    await user.type(id, "crm");
    await fillRest(user, "devresponse-app:crm");
    await user.click(screen.getByRole("button", { name: "Create application" }));

    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(postedBody()).toMatchObject({ id: "crm", organization_id: null });
  });

  it("a superadmin can create the app in a chosen org instead", async () => {
    const user = userEvent.setup();
    stagePost({ status: 201, json: async () => ({ id: "crm" }) });
    const { container } = renderSuperadmin();
    await pickerLoaded(container);
    await user.click(container.querySelector("#enterprise-app-organization")!);
    await user.click(await screen.findByRole("option", { name: /Globex/ }));
    await user.type(screen.getByRole("textbox", { name: "ID" }), "crm");
    await fillRest(user, "devresponse-app:crm");
    await user.click(screen.getByRole("button", { name: "Create application" }));

    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(postedBody()).toMatchObject({ id: "crm", organization_id: GLOBEX_ID });
  });
});
