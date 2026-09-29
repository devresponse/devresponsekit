// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * The Email outbox toolbar's "Send test email" control. F-64: only a caller
 * with cross-org reach chooses the recipient; an org admin's test email goes to
 * their own address, which the page passes in (`testRecipient`) and the field
 * shows read-only, so the control never offers a send the route refuses. A 429
 * from the per-actor or the org's daily budget says so.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/en/app/administrator/email",
  useSearchParams: () => new URLSearchParams(""),
  redirect: vi.fn(),
  permanentRedirect: vi.fn(),
  notFound: vi.fn(),
}));

import { AdministratorOutboxGrid } from "@/app/[locale]/(secure)/app/administrator/email/_outbox-grid";

const fetchMock = vi.fn();

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** The bodies POSTed to the test route. */
function testSends(): unknown[] {
  return fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        String(input) === "/api/administrator/email/test" &&
        (init as { method?: string } | undefined)?.method === "POST",
    )
    .map(([, init]) => JSON.parse(String((init as { body: string }).body)));
}

let testAnswer: { body: unknown; status: number };

beforeEach(() => {
  testAnswer = { body: { ok: true, outboxId: "o-1", status: "logged" }, status: 200 };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: unknown, init?: { method?: string }) => {
    if (String(input) === "/api/administrator/email/test" && init?.method === "POST") {
      return json(testAnswer.body, testAnswer.status);
    }
    return json({ items: [], page: 1, pageSize: 50, total: 0, sort: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("Send test email (F-64)", () => {
  it("fixes an org admin's recipient to their own address, read-only, and sends there", async () => {
    const user = userEvent.setup();
    renderWithIntl(<AdministratorOutboxGrid canManage testRecipient="me@org.test" />);

    const field = screen.getByRole("textbox", { name: "recipient@example.com" });
    expect(field).toHaveValue("me@org.test");
    expect(field).toHaveAttribute("readonly");
    await user.type(field, "x");
    expect(field).toHaveValue("me@org.test");

    await user.click(screen.getByRole("button", { name: "Send test email" }));
    expect(
      await screen.findByText("Recorded in the outbox (no delivery provider configured)."),
    ).toBeInTheDocument();
    expect(testSends()).toEqual([{ to: "me@org.test" }]);
    // Still their address, ready for another send.
    expect(field).toHaveValue("me@org.test");
  });

  it("lets a caller with cross-org reach type any recipient", async () => {
    const user = userEvent.setup();
    renderWithIntl(<AdministratorOutboxGrid canManage testRecipient={null} />);

    const field = screen.getByRole("textbox", { name: "recipient@example.com" });
    expect(field).toHaveValue("");
    expect(field).not.toHaveAttribute("readonly");
    await user.type(field, "ops@anywhere.test");
    await user.click(screen.getByRole("button", { name: "Send test email" }));
    await screen.findByText("Recorded in the outbox (no delivery provider configured).");
    expect(testSends()).toEqual([{ to: "ops@anywhere.test" }]);
  });

  it("says the budget is spent on a 429", async () => {
    testAnswer = { body: { error: "rate_limited", retryAfter: 360 }, status: 429 };
    const user = userEvent.setup();
    renderWithIntl(<AdministratorOutboxGrid canManage testRecipient="me@org.test" />);

    await user.click(screen.getByRole("button", { name: "Send test email" }));
    expect(await screen.findByText("Too many requests. Please slow down.")).toBeInTheDocument();
  });
});
