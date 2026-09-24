import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Systemic guard for review #98 and F-19: a PRE-AUTH rate-limit floor consumes
 * from the SHARED (Postgres-backed) bucket, never from the per-process one.
 *
 * The in-memory limiter is per lambda on Vercel, so a floor taken from it
 * multiplies by the instance count. That matters wherever the caller chooses
 * the fan-out: nothing about it is verified yet, so the bucket is keyed on the
 * client's network address. Routing today's floors through `consumeSharedToken`
 * / `enforceSharedRateLimit` / the tiered helper is not enough, since the next
 * edit could put an in-memory call back, so the call sites are checked on
 * every run.
 *
 * F-19: this file used to name the four floors it checked (token endpoint, MCP
 * registration, CSP sink, invitation acceptance). `/api/sso/consume` and the
 * signed-out `/api/sso/launch` were IP-keyed floors in the in-memory bucket and
 * were never on that list, so a garbage-token flood spread over N warm
 * instances got N times the per-IP budget while this test stayed green. The
 * rules are now DERIVED from the source instead of enumerated:
 *
 *   1. No in-memory limiter call anywhere under `src/` (`consumeToken(` or
 *      `enforceRateLimit(`) names its bucket after the client's address. Its
 *      key argument (for `enforceRateLimit`, the scope or the actor) must not
 *      call `clientIpKey`, `actorIdFromRequest` (the alias the SSO routes
 *      used; removed in F-19) or `getClientIp`. That holds whether the call
 *      is direct, in either arm of a ternary, or reached through a same-file
 *      `const` or helper function. The scan walks the TypeScript AST, so a
 *      comment that quotes a call is not a call, and a ternary is a subtree
 *      like any other. An exception needs an entry, with its reason, in
 *      `IN_MEMORY_CLIENT_KEYED_ALLOWED`; there are none.
 *   2. A negative control plants every one of those shapes, and the clean
 *      shapes the real tree relies on, in synthetic sources, so the scanner
 *      is proven to catch what rule 1 claims (and to pass what it must).
 *   3. A floor keyed on a PRINCIPAL anyone can self-register cannot be told
 *      apart from an authenticated per-actor limit by its source text, so
 *      those few are named, with the reason: invitation acceptance.
 *
 * F-18 added the ORDER: a deployment-wide floor may only be charged for a
 * request its per-source (per-IP) bucket admitted, or one IP spends everyone's
 * budget with requests it is itself refused. The order lives in ONE helper,
 * `consumeSourceThenGlobal` (src/lib/admin/rate-limit-tiered.server.ts), and:
 *
 *   4. `__global__` is spelled nowhere under `src/` but that helper, so no
 *      route can build a global key and consume it itself, before (or
 *      without) its per-source bucket, whether it passes the key to
 *      `consumeSharedToken` inline or through a variable.
 *   5. The helper itself consumes from the shared bucket.
 */
const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));

const SHARED_MODULE = "@/lib/admin/rate-limit-shared.server";
const TIERED_FILE = join(SRC_DIR, "lib", "admin", "rate-limit-tiered.server.ts");

/**
 * The per-process limiter's entry points, and the positions of the arguments
 * that name the bucket: `consumeToken(key, …)`, `enforceRateLimit(scope,
 * actorId, …)`.
 */
const IN_MEMORY_LIMITERS = new Map<string, readonly number[]>([
  ["consumeToken", [0]],
  ["enforceRateLimit", [0, 1]],
]);

/** The shared entry points and their key-bearing arguments. */
const SHARED_LIMITERS = new Map<string, readonly number[]>([
  ["consumeSharedToken", [0]],
  ["enforceSharedRateLimit", [0, 1]],
  ["consumeSourceThenGlobal", [0, 1]],
]);

/** Calls whose value is the client's network address, or a key built from it. */
const CLIENT_ADDRESS_SOURCES = new Set(["clientIpKey", "actorIdFromRequest", "getClientIp"]);

/**
 * src-relative file → why its in-memory, client-address-keyed call is sound.
 * Empty: every such floor is shared. An entry must name a file that still has
 * such a call, or it is stale and fails below.
 */
const IN_MEMORY_CLIENT_KEYED_ALLOWED: Readonly<Record<string, string>> = {};

/**
 * Floors keyed on a principal that anyone can obtain, which rule 1 cannot
 * derive: src/app/api-relative file → the shared primitive it must call, and why.
 */
const SHARED_PRINCIPAL_FLOORS: ReadonlyArray<[file: string, primitive: string, reason: string]> = [
  [
    "invitations/accept/route.ts",
    "enforceSharedRateLimit",
    "keyed on the session user id, but any self-registered pending_approval account has a " +
      "session, so it is a token-guessing floor whose fan-out the caller chooses (review #98)",
  ],
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(?:ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const srcRelative = (full: string) => relative(SRC_DIR, full).replace(/\\/g, "/");

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

/** Every call in `sf` whose callee is named one of `names`. */
function callsNamed(sf: ts.SourceFile, names: ReadonlySet<string>): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name !== undefined && names.has(name)) out.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Same-file names a key argument can reach: a variable's initializer (which
 * covers an arrow function) or a function declaration's body. Keyed by name
 * only, not by scope, so a name that is client-derived anywhere in the file
 * counts everywhere in it: a false positive costs an allow-list entry, a
 * false negative costs the floor.
 */
function localBindings(sf: ts.SourceFile): Map<string, ts.Node[]> {
  const out = new Map<string, ts.Node[]>();
  const add = (name: string, node: ts.Node) => out.set(name, [...(out.get(name) ?? []), node]);
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      add(node.name.text, node.initializer);
    } else if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      add(node.name.text, node.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** `b` in `a.b` and `{ b: … }` is a member name, not a reference to a binding. */
function isMemberName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node)
  );
}

/** Whether `node` calls a client-address source, following same-file bindings. */
function derivesFromClientAddress(
  node: ts.Node,
  bindings: Map<string, ts.Node[]>,
  seen: Set<ts.Node> = new Set(),
): boolean {
  if (seen.has(node)) return false;
  seen.add(node);
  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    if (name !== undefined && CLIENT_ADDRESS_SOURCES.has(name)) return true;
  }
  if (ts.isIdentifier(node) && !isMemberName(node)) {
    for (const bound of bindings.get(node.text) ?? []) {
      if (derivesFromClientAddress(bound, bindings, seen)) return true;
    }
  }
  return (
    ts.forEachChild(node, (child) =>
      derivesFromClientAddress(child, bindings, seen) ? true : undefined,
    ) ?? false
  );
}

interface KeyedCall {
  line: number;
  call: string;
}

/** Calls to `limiters` in `sf` whose key-bearing argument derives from the client's address. */
function clientKeyedCalls(
  sf: ts.SourceFile,
  limiters: ReadonlyMap<string, readonly number[]>,
): KeyedCall[] {
  const bindings = localBindings(sf);
  return callsNamed(sf, new Set(limiters.keys()))
    .filter((call) =>
      (limiters.get(calleeName(call)!) ?? []).some((i) => {
        const arg = call.arguments[i];
        return arg !== undefined && derivesFromClientAddress(arg, bindings);
      }),
    )
    .map((call) => ({
      line: sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1,
      call: call.getText(sf).replace(/\s+/g, " "),
    }));
}

/** Rule 1's scanner: the in-memory limiter calls in a source keyed on the client's address. */
function inMemoryClientKeyedCalls(fileName: string, text: string): KeyedCall[] {
  return clientKeyedCalls(parse(fileName, text), IN_MEMORY_LIMITERS);
}

/** Every source file under src/, parsed once. */
const SRC_FILES = walk(SRC_DIR).map((full) => {
  const rel = srcRelative(full);
  const text = readFileSync(full, "utf8");
  return { full, rel, text, sf: parse(rel, text) };
});

describe("F-19: no in-memory limiter under src/ is keyed on the client's address (derived)", () => {
  it("every IP-keyed limiter call under src/ is a shared one", () => {
    const offenders: string[] = [];
    for (const { rel, sf } of SRC_FILES) {
      if (IN_MEMORY_CLIENT_KEYED_ALLOWED[rel]) continue;
      for (const hit of clientKeyedCalls(sf, IN_MEMORY_LIMITERS)) {
        offenders.push(`${rel}:${hit.line}  ${hit.call}`);
      }
    }
    expect(
      offenders,
      "an in-memory bucket keyed on the client IP is a pre-auth floor that multiplies by the " +
        "instance count; take it from the shared bucket (enforceSharedRateLimit / " +
        "consumeSourceThenGlobal) or add an allow-list entry with a reason",
    ).toEqual([]);
  });

  it("names only live exceptions, each with a reason", () => {
    for (const [file, reason] of Object.entries(IN_MEMORY_CLIENT_KEYED_ALLOWED)) {
      expect(reason.trim().length, `${file} needs a reason`).toBeGreaterThan(0);
      const source = SRC_FILES.find((f) => f.rel === file);
      expect(source, `allow-list names ${file}, which does not exist`).toBeDefined();
      expect(
        clientKeyedCalls(source!.sf, IN_MEMORY_LIMITERS).length,
        `allow-list names ${file}, which no longer has an in-memory IP-keyed call — drop the entry`,
      ).toBeGreaterThan(0);
    }
  });

  it("walks the real limiter surface (the scan is not vacuous)", () => {
    const inMemory = new Set(IN_MEMORY_LIMITERS.keys());
    const calls = SRC_FILES.flatMap(({ rel, sf }) =>
      callsNamed(sf, inMemory).map((c) => ({ rel, text: c.getText(sf) })),
    );
    // Every admin mutation calls `enforceRateLimit`; a count this low means the
    // walk or the callee match is broken, not that the surface shrank.
    expect(calls.length).toBeGreaterThan(50);
    // The token endpoint's post-verify, per-credential bucket stays in memory
    // (keyed on a VERIFIED credential) and must be seen, and not be reported.
    const credential = calls.filter((c) => c.text.includes("api.token.credential"));
    expect(credential).toHaveLength(1);
    expect(credential[0]!.rel).toBe("app/api/v1/auth/token/route.ts");
  });

  it("finds the IP-keyed floors it protects in the shared bucket", () => {
    const floors = SRC_FILES.filter(
      ({ rel, sf }) => rel.startsWith("app/") && clientKeyedCalls(sf, SHARED_LIMITERS).length > 0,
    ).map(({ rel }) => rel);
    // The token endpoint, MCP registration, the CSP sink, SSO consume and the
    // signed-out SSO launch. A shrink means a floor left the shared bucket
    // (or stopped being limited), not that the surface got smaller.
    expect(floors.length).toBeGreaterThanOrEqual(5);
  });
});

describe("F-19: the scanner catches every shape rule 1 claims (negative control)", () => {
  const PLANTED: ReadonlyArray<[shape: string, source: string]> = [
    [
      "clientIpKey as the actor",
      `enforceRateLimit("x", clientIpKey(request.headers), L, request);`,
    ],
    ["actorIdFromRequest as the actor", `enforceRateLimit("x", actorIdFromRequest(request), L);`],
    [
      "the pre-F-19 launch ternary",
      `const session = await getCurrentSession();
       const limited = enforceRateLimit(
         "sso.launch",
         session ? session.user.id : actorIdFromRequest(request),
         DEFAULT_SSO_LAUNCH_LIMIT,
         request,
       );`,
    ],
    ["an IP inside a consumeToken key", `consumeToken(rateLimitKey("x", clientIpKey(h)), L);`],
    ["the raw client IP", `consumeToken(rateLimitKey("x", getClientIp(h) ?? "anon"), L);`],
    ["the IP as the scope", `enforceRateLimit(clientIpKey(h), "user-1");`],
    [
      "an IP through two consts",
      `const ip = clientIpKey(request.headers);
       const key = rateLimitKey("x", ip);
       consumeToken(key, L);`,
    ],
    [
      "an IP through a local helper",
      `function sourceOf(r: { headers: Headers }) { return actorIdFromRequest(r); }
       export function GET(request: Request) { return enforceRateLimit("x", sourceOf(request), L); }`,
    ],
    [
      "an IP through an arrow helper",
      `const sourceOf = (r: { headers: Headers }) => clientIpKey(r.headers);
       enforceRateLimit("x", sourceOf(request));`,
    ],
    ["a namespace-qualified limiter", `rl.enforceRateLimit("x", clientIpKey(request.headers));`],
    ["a namespace-qualified source", `enforceRateLimit("x", ip.clientIpKey(request.headers));`],
  ];

  it.each(PLANTED)("reports %s", (_shape, source) => {
    expect(inMemoryClientKeyedCalls("planted.ts", source)).toHaveLength(1);
  });

  const CLEAN: ReadonlyArray<[shape: string, source: string]> = [
    [
      "a user-keyed admin bucket",
      `enforceRateLimit("admin.users.create", guard.betterAuthUserId, L, request, guard.requestId);`,
    ],
    [
      "the post-verify credential bucket",
      `consumeToken(rateLimitKey("api.token.credential", credentialLabel), L);`,
    ],
    [
      "the F-19 launch split (only the shared arm is IP-keyed)",
      `const session = await getCurrentSession();
       const limited = session
         ? enforceRateLimit("sso.launch", session.user.id, DEFAULT_SSO_LAUNCH_LIMIT, request)
         : await enforceSharedRateLimit("sso.launch.signed_out", clientIpKey(request.headers), L, request);`,
    ],
    [
      "a shared floor keyed on the IP",
      `await consumeSourceThenGlobal("x", clientIpKey(request.headers), T);`,
    ],
    [
      "a comment that quotes the old call",
      `// was: enforceRateLimit("x", clientIpKey(request.headers))
       enforceRateLimit("x", userId);`,
    ],
    [
      "an IP in a non-key argument",
      `enforceRateLimit("x", userId, L, { headers: withIp(clientIpKey(h)) });`,
    ],
    [
      "a member that merely shares a client-derived name",
      `const id = clientIpKey(h);
       enforceRateLimit("x", session.user.id);`,
    ],
  ];

  it.each(CLEAN)("does not report %s", (_shape, source) => {
    expect(inMemoryClientKeyedCalls("clean.ts", source)).toEqual([]);
  });
});

describe("review #98: principal-keyed pre-auth floors stay shared (named: not derivable)", () => {
  it.each(SHARED_PRINCIPAL_FLOORS)("%s calls %s — %s", (file, primitive) => {
    const text = readFileSync(join(SRC_DIR, "app", "api", file), "utf8");
    expect(text, `${file} must import ${SHARED_MODULE}`).toContain(`from "${SHARED_MODULE}"`);
    const sf = parse(file, text);
    expect(callsNamed(sf, new Set([primitive])).length).toBeGreaterThan(0);
    expect(callsNamed(sf, new Set(IN_MEMORY_LIMITERS.keys()))).toEqual([]);
  });
});

describe("F-18: a global floor is charged only after its per-source bucket admits", () => {
  it('no file under src/ consumes a "__global__" key from the in-memory bucket', () => {
    const offenders: string[] = [];
    for (const { rel, text, sf } of SRC_FILES) {
      if (!text.includes("__global__")) continue;
      for (const call of callsNamed(sf, new Set(IN_MEMORY_LIMITERS.keys()))) {
        if (call.getText(sf).includes("__global__")) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('"__global__" is spelled nowhere under src/ but the tiered helper', () => {
    // A route that spells the global key can consume it itself, and taking it
    // first is exactly the bug: every request its IP bucket then refused had
    // already spent a deployment-wide token. Go through consumeSourceThenGlobal.
    const spelledIn = SRC_FILES.filter(({ text }) => text.includes("__global__")).map(({ full }) =>
      full.replace(/\\/g, "/"),
    );
    expect(spelledIn).toEqual([TIERED_FILE.replace(/\\/g, "/")]);
  });

  it("the tiered helper consumes both of its tiers from the shared bucket", () => {
    const text = readFileSync(TIERED_FILE, "utf8");
    expect(text).toContain(`from "${SHARED_MODULE}"`);
    const sf = parse(TIERED_FILE, text);
    expect(callsNamed(sf, new Set(["consumeSharedToken"]))).toHaveLength(2);
    expect(callsNamed(sf, new Set(IN_MEMORY_LIMITERS.keys()))).toEqual([]);
  });

  it("discovers the tiered floors it protects (the scan is not vacuous)", () => {
    const tiered = new Set(["consumeSourceThenGlobal"]);
    const callers = SRC_FILES.filter(
      ({ rel, sf }) => rel.startsWith("app/") && callsNamed(sf, tiered).length > 0,
    );
    // token, register, csp-report — a shrink means a floor was dropped, not
    // that the surface got smaller. The SSO pair takes a per-IP bucket only
    // (F-19): a floor in front of token verification would lock out real users.
    expect(callers.length).toBeGreaterThanOrEqual(3);
  });
});
