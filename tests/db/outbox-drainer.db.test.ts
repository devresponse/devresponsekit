import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DB-BACKED test for the P3-8 outbox drainer edges.
 *
 *   Edge A — the claim must filter on the ACTIVE provider, so a row enqueued
 *     for a since-replaced provider is NOT re-sent through the new one (which
 *     would use a `from_email` the new provider may not own).
 *   Edge B — a delivery failure must persist a SHORT, single-line reason in
 *     `app_outbox.error` (admin-visible, org-scoped), never the provider's raw
 *     multi-line response body.
 *
 * Runs `drainOutbox` against real Postgres; only the provider is mocked (the
 * `db` pool is real). Driven by `pnpm test:db`. Fixtures use `__dbtest_`.
 */
const state = vi.hoisted(() => ({
  provider: null as null | {
    id: string;
    deliver: (e: unknown) => Promise<{ providerMessageId?: string }>;
  },
}));

vi.mock("@/lib/email/providers.server", () => ({
  getConfiguredEmailProvider: () => state.provider,
}));

const { db, pgPool } = await import("@/db/database");
const { drainOutbox } = await import("@/lib/email/outbox-worker.server");

const PREFIX = "__dbtest_drain_";

async function insertPending(provider: string): Promise<string> {
  const row = await db
    .insertInto("app_outbox")
    .values({
      organization_id: null,
      template_key: "test_email",
      to_email: `${PREFIX}${provider}@dbtest.local`,
      from_email: `no-reply-${provider}@dbtest.local`,
      subject: "s",
      body_html: "<p>x</p>",
      body_text: null,
      variables: JSON.stringify({}),
      status: "pending",
      provider,
      next_attempt_at: null, // immediately due
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function getRow(id: string) {
  return db
    .selectFrom("app_outbox")
    .select(["id", "status", "provider", "attempts", "error"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

beforeEach(async () => {
  state.provider = null;
  await db.deleteFrom("app_outbox").where("to_email", "like", `${PREFIX}%`).execute();
});
afterAll(async () => {
  await db.deleteFrom("app_outbox").where("to_email", "like", `${PREFIX}%`).execute();
  await pgPool.end();
});

describe("drainOutbox (DB-backed, P3-8)", () => {
  it("Edge A: claims only rows enqueued for the active provider", async () => {
    const resendId = await insertPending("resend");
    const mailgunId = await insertPending("mailgun");
    state.provider = { id: "resend", deliver: async () => ({ providerMessageId: "m1" }) };

    const result = await drainOutbox(10);

    // Only the active-provider row is claimed and sent.
    expect(result).toMatchObject({ claimed: 1, sent: 1 });
    expect((await getRow(resendId)).status).toBe("sent");
    // The row for the now-inactive provider is left completely untouched —
    // not re-sent through `resend` with mailgun's `from_email`.
    const mailgun = await getRow(mailgunId);
    expect(mailgun.status).toBe("pending");
    expect(mailgun.attempts).toBe(0);
  });

  it("Edge B: persists a short, single-line reason — never the raw provider body", async () => {
    const id = await insertPending("resend");
    // A realistic hostile/verbose provider failure: status prefix + a long,
    // multi-line HTML body (as providers.server embeds via `await res.text()`).
    const rawBody = `resend 500: <!doctype html>\n${"<div>err</div>\n".repeat(400)}`;
    state.provider = {
      id: "resend",
      deliver: async () => {
        throw new Error(rawBody);
      },
    };

    await drainOutbox(10);

    const { error } = await getRow(id);
    expect(error).toBeTruthy();
    expect(error!).not.toContain("\n"); // collapsed to a single line
    expect(error!.length).toBeLessThanOrEqual(201); // 200 chars + the ellipsis
    expect(error!.startsWith("resend 500:")).toBe(true); // useful prefix kept
    expect(error!).not.toContain(rawBody); // the raw body is NOT stored verbatim
  });
});
