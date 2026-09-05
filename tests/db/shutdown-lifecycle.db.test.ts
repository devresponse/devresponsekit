import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Review #24 — real-process proof of the shutdown ordering.
 *
 * A child process (tests/db/fixtures/shutdown-child.ts) runs the REAL app
 * pool + the REAL shutdown module behind a stand-in for Next's signal
 * `cleanup` (drain HTTP, exit 143/130). With a request in flight that holds a
 * pool client and then checks a second one out, a SIGTERM must:
 *
 *   - NOT end the pool before the request completes (it completes 200), and
 *   - leave the exit code to the HTTP drain (143/130), not replace it with 0;
 *
 * and when the drain overruns SHUTDOWN_TIMEOUT_MS the watchdog must end the
 * pool and exit 143 itself, so a stuck request can never hang the shutdown.
 *
 * Runs under `pnpm test:db` (needs a live DATABASE_URL, inherited by the
 * child). On POSIX the signal is a real `kill`; Windows has no POSIX signals,
 * so there the parent asks the child over IPC to raise the same event.
 */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CHILD = fileURLToPath(new URL("./fixtures/shutdown-child.ts", import.meta.url));
const POOL_END_ERROR = "Cannot use a pool after calling end";

type Signal = "SIGTERM" | "SIGINT";

interface Child {
  proc: ChildProcess;
  lines: string[];
  stderr: string[];
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  waitForLine: (prefix: string, timeoutMs?: number) => Promise<string>;
}

function startChild(env: Record<string, string>): Child {
  const proc = spawn(process.execPath, ["--import", "tsx", "--conditions=react-server", CHILD], {
    cwd: REPO_ROOT,
    env: { ...process.env, NODE_ENV: "test", SKIP_ENV_VALIDATION: "1", ...env },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const lines: string[] = [];
  const stderr: string[] = [];
  let buffered = "";
  proc.stdout!.setEncoding("utf8");
  proc.stdout!.on("data", (chunk: string) => {
    buffered += chunk;
    const parts = buffered.split("\n");
    buffered = parts.pop() ?? "";
    lines.push(...parts.map((line) => line.trim()).filter(Boolean));
  });
  proc.stderr!.setEncoding("utf8");
  proc.stderr!.on("data", (chunk: string) => stderr.push(chunk));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const waitForLine = async (prefix: string, timeoutMs = 15_000): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = lines.find((line) => line.startsWith(prefix));
      if (hit) return hit;
      if (proc.exitCode !== null) {
        throw new Error(
          `child exited (${proc.exitCode}) before "${prefix}"\nstdout:\n${lines.join("\n")}\nstderr:\n${stderr.join("")}`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for "${prefix}"\nstdout:\n${lines.join("\n")}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { proc, lines, stderr, exit, waitForLine };
}

function deliver(child: Child, signal: Signal): void {
  if (process.platform === "win32") {
    // `child.kill()` on Windows is an unconditional TerminateProcess — no
    // handler ever runs — so raise the event in-process instead.
    child.proc.send({ signal });
  } else {
    child.proc.kill(signal);
  }
}

async function withChild<T>(env: Record<string, string>, run: (child: Child) => Promise<T>) {
  const child = startChild(env);
  try {
    return await run(child);
  } finally {
    if (child.proc.exitCode === null) child.proc.kill("SIGKILL");
  }
}

describe("shutdown lifecycle (review #24, real process)", () => {
  it.each<[Signal, number]>([
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ])(
    "%s with an in-flight pool-holding request: the request completes 200, the pool is never ended, exit is %i",
    async (signal, expectedCode) => {
      await withChild({ CHILD_HOLD_MS: "400", SHUTDOWN_TIMEOUT_MS: "10000" }, async (child) => {
        const port = (await child.waitForLine("LISTENING ")).split(" ")[1];
        const response = fetch(`http://127.0.0.1:${port}/`);
        await child.waitForLine("REQ_START");

        deliver(child, signal);

        const res = await response;
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("ok");

        const { code } = await child.exit;
        // The stand-in Next's drain owns the exit code — not an exit(0) from us.
        expect(code).toBe(expectedCode);

        const done = child.lines.findIndex((line) => line.startsWith("REQ_DONE"));
        expect(child.lines[done]).toBe("REQ_DONE 200");
        // Our module must never have ended the pool while the request ran —
        // in the normal path it never ends it at all (the OS closes the idle
        // sockets at Next's exit).
        expect(child.lines).not.toContain("POOL_END");
        expect(child.stderr.join("")).not.toContain(POOL_END_ERROR);
      });
    },
  );

  it("watchdog: when the HTTP drain overruns SHUTDOWN_TIMEOUT_MS the pool is ended and the process exits 143", async () => {
    await withChild(
      { CHILD_HOLD_MS: "4000", SHUTDOWN_TIMEOUT_MS: "500", CHILD_NEXT_DRAINS: "0" },
      async (child) => {
        const port = (await child.waitForLine("LISTENING ")).split(" ")[1];
        // Settle the outcome eagerly: the socket is reset while we still await
        // the exit below, and an unattached rejection would fail the run.
        const outcome = fetch(`http://127.0.0.1:${port}/`).then(
          (res) => ({ answered: true as const, status: res.status }),
          (err: unknown) => ({ answered: false as const, err }),
        );
        await child.waitForLine("REQ_START");

        const sentAt = Date.now();
        deliver(child, "SIGTERM");

        const { code } = await child.exit;
        const elapsed = Date.now() - sentAt;
        // Bounded by the budget (+ slack for process teardown), NOT by the
        // 4s query the stand-in Next would otherwise have waited for.
        expect(code).toBe(143);
        expect(elapsed).toBeGreaterThanOrEqual(450);
        expect(elapsed).toBeLessThan(3_000);
        // The watchdog kicked pgPool.end() before exiting...
        expect(child.lines).toContain("POOL_END");
        // ...and the wedged request never got an answer (the process is gone).
        expect((await outcome).answered).toBe(false);
        expect(child.lines.some((line) => line.startsWith("REQ_DONE"))).toBe(false);
      },
    );
  });
});
