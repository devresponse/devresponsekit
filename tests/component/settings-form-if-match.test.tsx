// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { renderWithIntl } from "../helpers/render-with-intl";
import { OrganizationSettingsForm } from "@/app/[locale]/(secure)/app/administrator/organizations/[orgId]/_organization-settings-form";
import { RoleSettingsForm } from "@/app/[locale]/(secure)/app/administrator/roles/[roleId]/_role-settings-form";
import { GroupSettingsForm } from "@/app/[locale]/(secure)/app/administrator/groups/[groupId]/_group-settings-form";

/**
 * F-39: the organization, role and group Settings forms send the record's
 * ETag as `If-Match`, so a save made on a view of the record that someone
 * else has saved since is refused (412) instead of silently overwriting that
 * save. Before, two admins (or two tabs) editing one record each saw only
 * their own save, and the later one won field by field.
 *
 * Pinned for all three forms: the page's tag goes out as `If-Match`; a 412
 * names the conflict, reloads the page and keeps the admin's edit; the tag a
 * successful PATCH answers is used by the next save; and a new tag from the
 * page's props (the refresh landing) replaces the old one.
 */
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

const CONFLICT =
  "Someone else saved this record after you opened it, so your changes were not saved.";

const fetchMock = vi.fn();

function res(status: number, body: unknown, etag?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(etag ? { etag } : {}),
    json: async () => body,
  };
}

/** The `If-Match` header of every PATCH sent, in order. */
function ifMatchSent(): Array<string | undefined> {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as { method?: string }).method === "PATCH")
    .map(([, init]) => (init as { headers: Record<string, string> }).headers["if-match"]);
}

beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Case {
  kind: string;
  url: string;
  saved: string;
  render(etag: string, name?: string): ReactElement;
}

const cases: Case[] = [
  {
    kind: "organization",
    url: "/api/administrator/organizations/o1",
    saved: "Organization updated.",
    render: (etag, name = "Acme") => (
      <OrganizationSettingsForm
        orgId="o1"
        initialSlug="acme"
        initialName={name}
        initialStatus="active"
        initialIsDefault={false}
        isResolvedDefault={false}
        etag={etag}
        canUpdate
      />
    ),
  },
  {
    kind: "role",
    url: "/api/administrator/roles/r1",
    saved: "Saved.",
    render: (etag, name = "Acme") => (
      <RoleSettingsForm
        roleId="r1"
        initialKey="support"
        initialName={name}
        initialDescription={null}
        etag={etag}
        canUpdate
      />
    ),
  },
  {
    kind: "group",
    url: "/api/administrator/groups/g1",
    saved: "Saved.",
    render: (etag, name = "Acme") => (
      <GroupSettingsForm
        groupId="g1"
        initialKey="support"
        initialName={name}
        initialDescription={null}
        etag={etag}
        canUpdate
      />
    ),
  },
];

describe.each(cases)("$kind Settings form: If-Match (F-39)", ({ url, saved, render }) => {
  const name = () => screen.getByRole("textbox", { name: /^Name/ }) as HTMLInputElement;
  const save = () => screen.getByRole("button", { name: "Save changes" });

  it("sends the page's tag as If-Match on the PATCH", async () => {
    fetchMock.mockResolvedValue(res(200, { ok: true }, 'W/"v2"'));
    const user = userEvent.setup();
    renderWithIntl(render('W/"v1"'));

    await user.type(name(), " Corp");
    await user.click(save());

    expect(await screen.findByRole("status")).toHaveTextContent(saved);
    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ method: "PATCH" }));
    expect(ifMatchSent()).toEqual(['W/"v1"']);
  });

  it("a 412 names the conflict, reloads the page and keeps the edit; nothing claims a save", async () => {
    fetchMock.mockResolvedValue(res(412, { error: "precondition_failed" }, 'W/"theirs"'));
    const user = userEvent.setup();
    renderWithIntl(render('W/"v1"'));

    await user.type(name(), " Corp");
    await user.click(save());

    expect(await screen.findByRole("alert")).toHaveTextContent(CONFLICT);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);
    // The admin's edit survives the conflict, for the next save.
    expect(name()).toHaveValue("Acme Corp");
  });

  it("the next save sends the tag the last PATCH answered", async () => {
    fetchMock
      .mockResolvedValueOnce(res(200, { ok: true }, 'W/"v2"'))
      .mockResolvedValueOnce(res(200, { ok: true }, 'W/"v3"'));
    const user = userEvent.setup();
    renderWithIntl(render('W/"v1"'));

    await user.type(name(), " Corp");
    await user.click(save());
    expect(await screen.findByRole("status")).toHaveTextContent(saved);
    // A second save before the refresh lands is not refused for the first one.
    await user.type(name(), "!");
    await user.click(save());

    await waitFor(() => expect(ifMatchSent()).toEqual(['W/"v1"', 'W/"v2"']));
  });

  it("follows a new tag from the page's props (the refresh landing after a conflict)", async () => {
    fetchMock
      .mockResolvedValueOnce(res(412, { error: "precondition_failed" }))
      .mockResolvedValueOnce(res(200, { ok: true }, 'W/"v3"'));
    const user = userEvent.setup();
    const { rerender } = renderWithIntl(render('W/"v1"'));

    await user.type(name(), " Corp");
    await user.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent(CONFLICT);

    // The reload brings the other admin's save and its tag.
    rerender(render('W/"theirs"', "Acme Holdings"));
    await user.click(save());

    await waitFor(() => expect(ifMatchSent()).toEqual(['W/"v1"', 'W/"theirs"']));
    // Only the field this admin changed is sent; the edit kept its value.
    const bodies = fetchMock.mock.calls.map(([, init]) =>
      JSON.parse((init as { body: string }).body),
    );
    expect(bodies.at(-1)).toEqual({ name: "Acme Corp" });
  });
});
