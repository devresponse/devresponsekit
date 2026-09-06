import { describe, expect, it } from "vitest";
import {
  findSessionToken,
  normalizeSessionList,
  SESSION_ITEM_KEYS,
  toSessionItem,
} from "@/lib/admin/session-item";

/**
 * The session projection behind `GET /api/administrator/users/[id]/sessions`
 * (review #67/#194): Better Auth rows carry `token` — the credential of that
 * session — and the console must only ever see metadata plus an `id` to
 * revoke by. These pin the projection itself; the route test pins that the
 * handler actually uses it.
 */
const RAW = {
  id: "sess_1",
  token: "sup3r-secret-session-token",
  userId: "ba-1",
  createdAt: new Date("2026-09-05T10:00:00.000Z"),
  updatedAt: "2026-09-05T10:05:00.000Z",
  expiresAt: new Date("2026-09-05T18:00:00.000Z"),
  ipAddress: "203.0.113.9",
  userAgent: "Mozilla/5.0",
  impersonatedBy: null,
  somethingNew: "from a future plugin version",
};

describe("toSessionItem", () => {
  it("keeps exactly the allow-listed keys — never token, userId, or unknown fields", () => {
    const item = toSessionItem(RAW);
    expect(Object.keys(item).sort()).toEqual([...SESSION_ITEM_KEYS].sort());
    expect(JSON.stringify(item)).not.toContain(RAW.token);
    expect(item).toEqual({
      id: "sess_1",
      createdAt: "2026-09-05T10:00:00.000Z",
      updatedAt: "2026-09-05T10:05:00.000Z",
      expiresAt: "2026-09-05T18:00:00.000Z",
      ipAddress: "203.0.113.9",
      userAgent: "Mozilla/5.0",
      impersonatedBy: null,
    });
  });

  it("normalizes Date and string timestamps to ISO, and blanks/non-strings to null", () => {
    const item = toSessionItem({
      id: "s",
      ipAddress: "",
      userAgent: 42,
      impersonatedBy: "admin-1",
    });
    expect(item.ipAddress).toBeNull();
    expect(item.userAgent).toBeNull();
    expect(item.impersonatedBy).toBe("admin-1");
    expect(item.createdAt).toBe("");
  });

  it("tolerates a non-object row (never throws inside the handler)", () => {
    expect(toSessionItem(null).id).toBe("");
    expect(toSessionItem("nonsense").id).toBe("");
  });
});

describe("normalizeSessionList", () => {
  it("accepts both Better Auth response shapes and nothing else", () => {
    expect(normalizeSessionList([RAW])).toEqual([RAW]);
    expect(normalizeSessionList({ sessions: [RAW] })).toEqual([RAW]);
    expect(normalizeSessionList(undefined)).toEqual([]);
    expect(normalizeSessionList({ sessions: "no" })).toEqual([]);
  });
});

describe("findSessionToken", () => {
  const other = { ...RAW, id: "sess_2", token: "other-token" };

  it("resolves an id to ITS token within the given list only", () => {
    expect(findSessionToken([other, RAW], "sess_1")).toBe(RAW.token);
    expect(findSessionToken({ sessions: [other] }, "sess_2")).toBe("other-token");
  });

  it("returns null for an unknown id, a token-less row, or a token passed as the id", () => {
    expect(findSessionToken([RAW], "sess_9")).toBeNull();
    expect(findSessionToken([{ id: "sess_1" }], "sess_1")).toBeNull();
    // The old contract took the token in the URL; that must not keep working.
    expect(findSessionToken([RAW], RAW.token)).toBeNull();
  });
});
