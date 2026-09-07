// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountApiKeysPanel } from "@/app/[locale]/(secure)/app/account/api-keys/_api-keys-panel";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * Per-row action buttons must be distinguishable (review #107).
 *
 * Both rows previously exposed the identical accessible names "Rotate" and
 * "Revoke": a screen-reader user tabbing the list heard the same two words
 * per key with nothing tying them to a row, and both actions are
 * destructive-ish (rotate invalidates the live secret).
 */
vi.mock("@/components/ui/dialog-manager", () => ({
  useDialogs: () => ({
    notify: vi.fn().mockResolvedValue(undefined),
    confirm: vi.fn().mockResolvedValue(false),
    promptText: vi.fn().mockResolvedValue(null),
  }),
}));

const fetchMock = vi.fn();

const KEYS = [
  {
    id: "k1",
    name: "CI deploy key",
    key_prefix: "drk_aaa",
    scopes: ["account.profile.read"],
    status: "active",
    expires_at: null,
    last_used_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    revoked_at: null,
  },
  {
    id: "k2",
    name: "Laptop key",
    key_prefix: "drk_bbb",
    scopes: [],
    status: "active",
    expires_at: null,
    last_used_at: null,
    created_at: "2026-01-02T00:00:00.000Z",
    revoked_at: null,
  },
];

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ items: KEYS }),
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("AccountApiKeysPanel", () => {
  it("names every row's Rotate/Revoke button after its key", async () => {
    renderWithIntl(<AccountApiKeysPanel grantableScopes={["account.profile.read"]} />);

    for (const name of ["CI deploy key", "Laptop key"]) {
      expect(await screen.findByRole("button", { name: `Rotate ${name}` })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: `Revoke ${name}` })).toBeInTheDocument();
    }
    // The ambiguous shared names are gone.
    expect(screen.queryByRole("button", { name: "Rotate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });
});
