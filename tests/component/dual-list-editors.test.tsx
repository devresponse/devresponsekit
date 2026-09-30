// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { renderWithIntl } from "../helpers/render-with-intl";
import { RolePermissionsEditor } from "@/app/[locale]/(secure)/app/administrator/roles/[roleId]/_role-permissions-editor";
import { GroupRolesEditor } from "@/app/[locale]/(secure)/app/administrator/groups/[groupId]/_group-roles-editor";

/**
 * F-38: both dual-list editors save through ONE atomic `PATCH { add, remove }`,
 * via the shared `useDualListSave`.
 *
 * They used to send a POST of the additions and then a DELETE of the removals.
 * When the DELETE was refused (403 AUTHZ-3 / REVOKE-1, 409 REVOKE-2) after the
 * POST had landed, the editor showed a generic error and kept its old
 * baseline, so the admin moved the keys back, Save went quiet, and the grant
 * the POST had committed stayed live and invisible. These pin, for BOTH
 * editors: one PATCH carries both sides; a swap of the role or permission the
 * actor's own authority comes through completes (the server judges both sides
 * against the authority the request found); a refused save lands nothing;
 * after any failure the lists and the baseline are reset to a fresh GET of the
 * server's set; the refusal is named; nothing moves while a save is in
 * flight; and an editor that cannot re-read the server locks itself.
 *
 * Each editor is driven against a small in-memory server: a successful PATCH
 * really changes the set the next GET returns, all of it or none of it.
 */
interface Harness {
  name: string;
  render(): ReactElement;
  saveUrl: string;
  /** Assigned before the test; `dropped` is removed and `extra` added by `stage`. */
  initial: string[];
  kept: string;
  dropped: string;
  extra: string;
  getBody(set: string[]): unknown;
  /** Answers the editor's other GETs (catalog, group detail); `undefined` when unrouted. */
  aux(url: string): unknown;
  messages: { forbidden: string; failed: string; saved: string };
  /**
   * Whether a save ends with `router.refresh()` (F-39): the role editor is
   * seeded from the page's props, the group editor fetches its own set.
   */
  refreshesPage: boolean;
}

const PERMISSION_CATALOG = ["admin.users.ban", "admin.users.read", "admin.users.update"].map(
  (key, i) => ({ id: `p${i}`, key, description: null, used_by_role_count: 0 }),
);

const roleEditor: Harness = {
  name: "RolePermissionsEditor",
  render: () => (
    <RolePermissionsEditor
      roleId="r1"
      initialAssigned={["admin.users.ban", "admin.users.read"]}
      canUpdate
    />
  ),
  saveUrl: "/api/administrator/roles/r1/permissions",
  initial: ["admin.users.ban", "admin.users.read"],
  kept: "admin.users.read",
  dropped: "admin.users.ban",
  extra: "admin.users.update",
  getBody: (set) => ({ permissions: set }),
  aux: (url) =>
    url.startsWith("/api/administrator/permissions") ? { items: PERMISSION_CATALOG } : undefined,
  messages: {
    forbidden: "You can only add or remove permissions you hold yourself.",
    failed: "Could not update permissions.",
    saved: "Permissions updated.",
  },
  refreshesPage: true,
};

const ROLE_CATALOG = [
  { id: "role-ban", key: "app.banner" },
  { id: "role-read", key: "app.reader" },
  { id: "role-update", key: "app.updater" },
].map((r) => ({ ...r, name: r.key, organization_id: "o1", organization_name: "Acme" }));

const groupEditor: Harness = {
  name: "GroupRolesEditor",
  render: () => <GroupRolesEditor groupId="g1" canAssign canReadRoles />,
  saveUrl: "/api/administrator/groups/g1/roles",
  initial: ["role-ban", "role-read"],
  kept: "role-read",
  dropped: "role-ban",
  extra: "role-update",
  getBody: (set) => ({ roles: ROLE_CATALOG.filter((r) => set.includes(r.id)) }),
  aux: (url) => {
    if (/\/api\/administrator\/groups\/g1$/.test(url)) {
      return { group: { id: "g1", organization_id: "o1" } };
    }
    if (url.startsWith("/api/administrator/roles?")) return { items: ROLE_CATALOG };
    return undefined;
  },
  messages: {
    forbidden: "You can only add or remove roles whose permissions you hold yourself.",
    failed: "Could not update roles.",
    saved: "Roles updated.",
  },
  refreshesPage: false,
};

// F-39: the role editor refreshes the page after every save, a failed one
// included (it may have landed half-way), so its RSC set catches up with what
// the save left on the server. `expectRefreshedOnce(h)` pins it on every outcome below.
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

const LAST_SUPERADMIN =
  "This is the last platform superadmin; the change would leave nobody able to administer the platform.";
const SAVE_STATE_UNKNOWN =
  "The saved state could not be reloaded. Reload the page before making more changes.";

const fetchMock = vi.fn();

function jsonRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

interface ServerOpts {
  patchStatus?: number;
  patchBody?: unknown;
  /** The PATCH's changes commit although it answers with an error (a commit, then a failure). */
  patchCommitsAnyway?: boolean;
  /** Status of every GET of the collection once a write has been sent. */
  rereadStatus?: number;
  /** Hold the PATCH open until `gate.release()` is called. */
  holdPatch?: boolean;
  /**
   * An actor whose own admin authority comes through the collection being
   * edited (the group bundles the role that grants them `admin.groups.*`, or
   * the role is their only source of `admin.roles.update`). The server
   * recomputes their permissions at the start of every request
   * (src/lib/auth-status.ts), so once its set holds none of these ids every
   * request to the collection is refused 403 `forbidden`, the re-read included.
   */
  authorityFrom?: string[];
}

function serve(h: Harness, opts: ServerOpts = {}) {
  const server = new Set(h.initial);
  const gate = { release: () => {} };
  let writes = 0;
  fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u === h.saveUrl) {
      if (method !== "GET") writes++;
      if (opts.authorityFrom && !opts.authorityFrom.some((id) => server.has(id))) {
        return jsonRes({ error: "forbidden" }, 403);
      }
    }
    if (u === h.saveUrl && method === "GET") {
      if (writes > 0 && opts.rereadStatus) return jsonRes({}, opts.rereadStatus);
      return jsonRes(h.getBody([...server].sort()));
    }
    if (u === h.saveUrl && method === "PATCH") {
      const { add, remove } = JSON.parse(init?.body ?? "{}") as { add: string[]; remove: string[] };
      if (opts.holdPatch) await new Promise<void>((resolve) => (gate.release = resolve));
      const status = opts.patchStatus ?? 200;
      // One transaction: both sides land, or neither does.
      if (status === 200 || opts.patchCommitsAnyway) {
        for (const id of add) server.add(id);
        for (const id of remove) server.delete(id);
      }
      return jsonRes(status === 200 ? { ok: true } : (opts.patchBody ?? {}), status);
    }
    const aux = h.aux(u);
    if (aux !== undefined) return jsonRes(aux);
    throw new Error(`unrouted fetch: ${method} ${u}`);
  });
  return { server, gate };
}

/** Every write the editor sent, in order, with the method and body of each. */
function writeCalls(): Array<{ method: string; body: unknown }> {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as { method?: string } | undefined)?.method !== undefined)
    .map(([, init]) => {
      const { method, body } = init as { method: string; body: string };
      return { method, body: JSON.parse(body) as unknown };
    });
}

function lists(): { available: HTMLSelectElement; assigned: HTMLSelectElement } {
  const [available, assigned] = screen.getAllByRole("listbox") as HTMLSelectElement[];
  return { available: available!, assigned: assigned! };
}

function values(list: HTMLSelectElement): string[] {
  return Array.from(list.querySelectorAll("option"))
    .map((o) => o.value)
    .filter(Boolean)
    .sort();
}

/** One `router.refresh()` per save for the editor seeded from props, none otherwise. */
function expectRefreshedOnce(h: Harness): void {
  expect(refresh).toHaveBeenCalledTimes(h.refreshesPage ? 1 : 0);
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

async function ready(h: Harness): Promise<void> {
  await waitFor(() => expect(screen.getAllByRole("listbox")).toHaveLength(2));
  await waitFor(() => expect(values(lists().available)).toContain(h.extra));
}

/** Moves `extra` into Assigned and `dropped` out of it, without saving. */
async function stage(
  user: ReturnType<typeof userEvent.setup>,
  h: Harness,
  { add = true, remove = true } = {},
): Promise<void> {
  if (add) {
    await user.selectOptions(lists().available, h.extra);
    await user.click(button("Add"));
  }
  if (remove) {
    await user.selectOptions(lists().assigned, h.dropped);
    await user.click(button("Remove"));
  }
}

beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each([roleEditor, groupEditor])("$name save (F-38)", (h) => {
  it("sends ONE PATCH carrying both sides, then adopts the server's re-read set", async () => {
    serve(h);
    const user = userEvent.setup();
    renderWithIntl(h.render());
    await ready(h);
    await stage(user, h);
    await user.click(button("Save changes"));

    expect(await screen.findByRole("status")).toHaveTextContent(h.messages.saved);
    expect(writeCalls()).toEqual([
      { method: "PATCH", body: { add: [h.extra], remove: [h.dropped] } },
    ]);
    expect(fetchMock.mock.calls.at(-1)).toEqual([h.saveUrl, { credentials: "same-origin" }]);
    expect(values(lists().assigned)).toEqual([h.extra, h.kept].sort());
    expect(button("Save changes")).toBeDisabled();
    expectRefreshedOnce(h);
  });

  it("completes a swap of the item the actor's own authority comes through", async () => {
    // `dropped` is the actor's only source of admin authority today and
    // `extra` an equivalent replacement. The server judges both sides against
    // the authority the request found, so the removal cannot refuse the
    // addition; sent as a DELETE first, it would have stranded every holder
    // with neither, and the actor could not put `dropped` back (AUTHZ-3).
    serve(h, { authorityFrom: [h.dropped, h.extra] });
    const user = userEvent.setup();
    renderWithIntl(h.render());
    await ready(h);
    await stage(user, h);
    await user.click(button("Save changes"));

    expect(await screen.findByRole("status")).toHaveTextContent(h.messages.saved);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(writeCalls()).toHaveLength(1);
    expect(values(lists().assigned)).toEqual([h.extra, h.kept].sort());
    expect(lists().available).toBeEnabled();
  });

  it("a refused save (403) lands nothing, resets to the server's set and names the guard", async () => {
    serve(h, { patchStatus: 403, patchBody: { error: "forbidden" } });
    const user = userEvent.setup();
    renderWithIntl(h.render());
    await ready(h);
    await stage(user, h);
    await user.click(button("Save changes"));

    expect(await screen.findByRole("alert")).toHaveTextContent(h.messages.forbidden);
    expect(writeCalls()).toHaveLength(1);
    // Neither side landed: the staged addition is not granted, the staged
    // removal did not happen, and the lists show exactly that.
    expect(values(lists().assigned)).toEqual([...h.initial].sort());
    expect(values(lists().available)).toContain(h.extra);
    expect(button("Save changes")).toBeDisabled();
    expectRefreshedOnce(h);
  });

  it.each([{ commits: true }, { commits: false }])(
    "a PATCH that fails (committed anyway: $commits) shows the server's set, never the stale baseline",
    async ({ commits }) => {
      const { server } = serve(h, { patchStatus: 500, patchCommitsAnyway: commits });
      const user = userEvent.setup();
      renderWithIntl(h.render());
      await ready(h);
      await stage(user, h);
      await user.click(button("Save changes"));

      expect(await screen.findByRole("alert")).toHaveTextContent(h.messages.failed);
      const expected = commits ? [h.extra, h.kept].sort() : [...h.initial].sort();
      expect(values(lists().assigned)).toEqual([...server].sort());
      expect(values(lists().assigned)).toEqual(expected);
      expectRefreshedOnce(h);
      // The baseline IS the server's set, so moving `extra` is a real pending
      // change: Save wakes up instead of going quiet over a live grant.
      expect(button("Save changes")).toBeDisabled();
      if (commits) {
        await user.selectOptions(lists().assigned, h.extra);
        await user.click(button("Remove"));
      } else {
        await user.selectOptions(lists().available, h.extra);
        await user.click(button("Add"));
      }
      expect(button("Save changes")).toBeEnabled();
    },
  );

  it("names the last-superadmin refusal (409 last_superadmin), and nothing lands", async () => {
    serve(h, {
      patchStatus: 409,
      patchBody: { error: "last_superadmin", message: "errors.last_superadmin" },
    });
    const user = userEvent.setup();
    renderWithIntl(h.render());
    await ready(h);
    await stage(user, h);
    await user.click(button("Save changes"));

    expect(await screen.findByRole("alert")).toHaveTextContent(LAST_SUPERADMIN);
    // The refused removal is still Assigned, and the addition was not made.
    expect(values(lists().assigned)).toEqual([...h.initial].sort());
    expectRefreshedOnce(h);
  });

  it("keeps the generic message for a 409 that is not last_superadmin", async () => {
    serve(h, { patchStatus: 409, patchBody: { error: "conflict" } });
    const user = userEvent.setup();
    renderWithIntl(h.render());
    await ready(h);
    await stage(user, h, { add: false });
    await user.click(button("Save changes"));

    expect(await screen.findByRole("alert")).toHaveTextContent(h.messages.failed);
  });

  it("disables Add, Remove, Save and both lists while a save is in flight", async () => {
    const { gate } = serve(h, { holdPatch: true });
    const user = userEvent.setup();
    renderWithIntl(h.render());
    await ready(h);
    await stage(user, h, { add: false });
    // Leave a selection in each list so Add and Remove would be live.
    await user.selectOptions(lists().available, h.extra);
    await user.selectOptions(lists().assigned, h.kept);
    expect(button("Add")).toBeEnabled();
    expect(button("Remove")).toBeEnabled();

    await user.click(button("Save changes"));

    const saving = await screen.findByRole("button", { name: "Saving…" });
    expect(saving).toBeDisabled();
    expect(button("Add")).toBeDisabled();
    expect(button("Remove")).toBeDisabled();
    expect(lists().available).toBeDisabled();
    expect(lists().assigned).toBeDisabled();

    gate.release();
    expect(await screen.findByRole("status")).toHaveTextContent(h.messages.saved);
    expect(writeCalls()).toEqual([{ method: "PATCH", body: { add: [], remove: [h.dropped] } }]);
    expect(lists().available).toBeEnabled();
  });

  it("locks the editor when a save fails and the server's set cannot be re-read", async () => {
    serve(h, { patchStatus: 500, rereadStatus: 500 });
    const user = userEvent.setup();
    renderWithIntl(h.render());
    await ready(h);
    await stage(user, h);
    // Leave a selection in each list, so Add and Remove are disabled below by
    // the lock alone (a failed re-read keeps the selections).
    await user.selectOptions(lists().available, h.dropped);
    await user.selectOptions(lists().assigned, h.kept);
    expect(button("Add")).toBeEnabled();
    expect(button("Remove")).toBeEnabled();
    await user.click(button("Save changes"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(h.messages.failed);
    expect(alert).toHaveTextContent(SAVE_STATE_UNKNOWN);
    // The page's set cannot be trusted either, so it is refreshed as well.
    expectRefreshedOnce(h);
    expect(button("Save changes")).toBeDisabled();
    expect(button("Add")).toBeDisabled();
    expect(button("Remove")).toBeDisabled();
    expect(lists().available).toBeDisabled();
    expect(lists().assigned).toBeDisabled();
  });
});
