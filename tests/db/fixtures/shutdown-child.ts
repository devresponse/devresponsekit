/**
 * Child process for tests/db/shutdown-lifecycle.db.test.ts (review #24).
 *
 * Stands in for `next start`: a tiny http server whose SIGTERM/SIGINT handling
 * mirrors Next's own `cleanup` in `next/dist/server/lib/start-server.js` (stop
 * accepting, wait for in-flight requests, exit 143/130) — wired to the REAL
 * app pool (`@/db/database`) and the REAL shutdown module, so the test proves
 * the actual ordering rather than a mock's.
 *
 * Every request checks a client out TWICE with a gap in between, the way
 * Kysely acquires per query: the second checkout is exactly what
 * `pgPool.end()` on the signal used to break ("Cannot use a pool after calling
 * end on the pool").
 *
 * Protocol (stdout, one line each):
 *   LISTENING <port>       server is up
 *   REQ_START              a request reached the handler
 *   POOL_END               something called pgPool.end() (must NOT happen
 *                          while a request is in flight)
 *   REQ_DONE <status> [m]  the handler answered
 *
 * Env knobs: CHILD_HOLD_MS (how long the first query sleeps), CHILD_NEXT_DRAINS
 * ("0" = the stand-in Next never exits after the drain, so only the watchdog
 * can end the process). Windows has no POSIX signals, so the parent may also
 * deliver the signal over IPC (`{ signal }`) and we raise the event ourselves.
 *
 * Run with: node --import tsx --conditions=react-server tests/db/fixtures/shutdown-child.ts
 * (the `react-server` condition resolves `server-only` to its no-op build).
 */
import { createServer } from "node:http";
import { pgPool } from "@/db/database";
import { registerGracefulShutdown, type ShutdownSignal } from "@/lib/shutdown.server";

const HOLD_MS = Number(process.env.CHILD_HOLD_MS ?? 400);
const NEXT_DRAINS = process.env.CHILD_NEXT_DRAINS !== "0";

const print = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

// Observe every pool end so the parent can assert it never happens mid-request.
const realEnd = pgPool.end.bind(pgPool);
pgPool.end = (() => {
  print("POOL_END");
  return realEnd();
}) as typeof pgPool.end;

registerGracefulShutdown();

const server = createServer((req, res) => {
  print("REQ_START");
  void (async () => {
    try {
      const first = await pgPool.connect();
      try {
        await first.query("select pg_sleep($1)", [HOLD_MS / 1000]);
      } finally {
        first.release();
      }
      // Between two queries of one request: the window the old handler broke.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = await pgPool.connect();
      try {
        await second.query("select 1");
      } finally {
        second.release();
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      print("REQ_DONE 200");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(message);
      print(`REQ_DONE 500 ${message}`);
    }
  })();
});

/** Next's `cleanup` analogue: stop accepting, drain, then exit with the signal code. */
const cleanup = (signal: ShutdownSignal): void => {
  server.close(() => {
    if (NEXT_DRAINS) process.exit(signal === "SIGINT" ? 130 : 143);
  });
};
process.on("SIGTERM", () => cleanup("SIGTERM"));
process.on("SIGINT", () => cleanup("SIGINT"));
process.on("message", (message: unknown) => {
  const signal = (message as { signal?: ShutdownSignal } | null)?.signal;
  if (signal === "SIGTERM" || signal === "SIGINT") process.emit(signal, signal);
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  print(`LISTENING ${port}`);
});
