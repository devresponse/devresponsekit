import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as NextServer from "next/server";
import type { SendAppEmailInput } from "@/lib/email/send.server";

/**
 * F-20: `deferEmailSend` takes the email send off the response path.
 *
 * Pinned here:
 *   - inside a request scope, the send is handed to `after()` as a CALLBACK,
 *     so nothing is sent until Next runs it after the response;
 *   - outside one (the real `after()` throws), the send starts at once and is
 *     not awaited, so the caller returns even when the send never settles;
 *   - a failed send is logged with the app logger, never rethrown, never an
 *     unhandled rejection, and the log line leaves out the variables (they
 *     carry the one-time link).
 */

const sendAppEmailMock = vi.fn();
vi.mock("@/lib/email/send.server", () => ({
  sendAppEmail: (...args: unknown[]) => sendAppEmailMock(...args),
}));

const logServerErrorMock = vi.fn();
vi.mock("@/lib/observability/logger.server", () => ({
  logServerError: (...args: unknown[]) => logServerErrorMock(...args),
}));

// `after` is routed through a mock whose default is the REAL implementation,
// so the out-of-scope tests exercise Next's own behaviour, not a stand-in.
const afterMock = vi.fn();
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof NextServer>();
  return { ...actual, after: (...args: unknown[]) => afterMock(...args) };
});

const INPUT: SendAppEmailInput = {
  to: "someone@example.com",
  templateKey: "password_reset",
  variables: { name: "Someone", resetUrl: "http://localhost:3000/reset-password/SECRET-TOKEN" },
  relatedBetterAuthUserId: "ba-1",
};

async function loadDeferEmailSend() {
  const { deferEmailSend } = await import("@/lib/email/defer-send.server");
  return deferEmailSend;
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(async () => {
  const actual = await vi.importActual<typeof NextServer>("next/server");
  afterMock.mockReset();
  afterMock.mockImplementation((task: Parameters<typeof actual.after>[0]) => actual.after(task));
  sendAppEmailMock.mockReset();
  logServerErrorMock.mockReset();
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
});

/** Lets pending microtasks and one macrotask run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("deferEmailSend outside a request scope (seeds, scripts, direct auth.api calls)", () => {
  it("relies on the real after() throwing there", async () => {
    const actual = await vi.importActual<typeof NextServer>("next/server");
    expect(() => actual.after(() => undefined)).toThrow(/outside a request scope/);
  });

  it("starts the send at once and returns without waiting for it", async () => {
    const deferEmailSend = await loadDeferEmailSend();
    sendAppEmailMock.mockReturnValue(new Promise(() => undefined)); // never settles

    expect(deferEmailSend(INPUT)).toBeUndefined();

    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(afterMock.mock.results[0]?.type).toBe("throw");
    expect(sendAppEmailMock).toHaveBeenCalledTimes(1);
    expect(sendAppEmailMock).toHaveBeenCalledWith(INPUT);
  });

  it("logs a failed send instead of throwing, with no unhandled rejection", async () => {
    const deferEmailSend = await loadDeferEmailSend();
    const failure = new Error("outbox insert failed");
    sendAppEmailMock.mockRejectedValue(failure);

    expect(() => deferEmailSend(INPUT)).not.toThrow();
    await vi.waitFor(() => expect(logServerErrorMock).toHaveBeenCalledTimes(1));
    await settle();

    expect(logServerErrorMock).toHaveBeenCalledWith("deferred email send failed", {
      err: failure,
      templateKey: "password_reset",
      betterAuthUserId: "ba-1",
    });
    // The variables hold the live reset link; they never reach the log.
    expect(JSON.stringify(logServerErrorMock.mock.calls[0]?.[1])).not.toContain("SECRET-TOKEN");
    expect(unhandled).toEqual([]);
  });

  it("logs a sender that throws synchronously, too", async () => {
    const deferEmailSend = await loadDeferEmailSend();
    const failure = new Error("template missing");
    sendAppEmailMock.mockImplementation(() => {
      throw failure;
    });

    expect(() => deferEmailSend({ ...INPUT, relatedBetterAuthUserId: undefined })).not.toThrow();
    await vi.waitFor(() =>
      expect(logServerErrorMock).toHaveBeenCalledWith("deferred email send failed", {
        err: failure,
        templateKey: "password_reset",
        betterAuthUserId: null,
      }),
    );
    await settle();
    expect(unhandled).toEqual([]);
  });
});

describe("deferEmailSend inside a request scope", () => {
  function captureAfterTasks(): unknown[] {
    const tasks: unknown[] = [];
    afterMock.mockImplementation((task: unknown) => {
      tasks.push(task);
    });
    return tasks;
  }

  it("sends nothing until Next runs the scheduled callback after the response", async () => {
    const deferEmailSend = await loadDeferEmailSend();
    const tasks = captureAfterTasks();
    sendAppEmailMock.mockResolvedValue({ outboxId: "o-1", status: "sent" });

    deferEmailSend(INPUT);
    await settle();

    // A callback, not a promise: a promise would already be running.
    expect(tasks).toHaveLength(1);
    expect(typeof tasks[0]).toBe("function");
    expect(sendAppEmailMock).not.toHaveBeenCalled();

    await (tasks[0] as () => Promise<void>)();
    expect(sendAppEmailMock).toHaveBeenCalledTimes(1);
    expect(sendAppEmailMock).toHaveBeenCalledWith(INPUT);
    expect(logServerErrorMock).not.toHaveBeenCalled();
  });

  it("resolves the scheduled callback when the send fails, and logs it", async () => {
    const deferEmailSend = await loadDeferEmailSend();
    const tasks = captureAfterTasks();
    const failure = new Error("provider unreachable");
    sendAppEmailMock.mockRejectedValue(failure);

    deferEmailSend(INPUT);

    // Resolves: a rejected task would only reach Next's console.error.
    await expect((tasks[0] as () => Promise<void>)()).resolves.toBeUndefined();
    expect(logServerErrorMock).toHaveBeenCalledWith(
      "deferred email send failed",
      expect.objectContaining({ err: failure, templateKey: "password_reset" }),
    );
    await settle();
    expect(unhandled).toEqual([]);
  });
});
