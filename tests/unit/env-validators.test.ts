import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  cookieDomainProblem,
  ed25519PrivateJwkProblem,
  httpOriginProblem,
  isLoopbackHost,
  splitEnvList,
} from "@/lib/env-validators";
// drk-deploy cannot import the kit across its package boundary (its tsconfig
// `rootDir` is its own `src`), so it carries a copy of the origin rule and of
// the key rule. This suite runs the origin pair over the same vectors, and
// tests/unit/env-signing-keys.test.ts the key pair: a change to one without
// the other fails (F-22).
import {
  httpOriginProblem as cliHttpOriginProblem,
  specFor as cliSpecFor,
} from "../../vercel-cli/src/lib/env-spec";

/**
 * The value rules behind the F-22 env checks. The vectors are adversarial on
 * purpose: the production outage was `httsp://`, a value that PARSES as a
 * URL, so a suite that only tried `not-a-url` could never have caught it.
 */

/** Values that are fine in development, whatever `exact` says. */
const ACCEPTED_ANYWHERE = [
  "https://app.example.com",
  "https://demo.devresponse.ca",
  "https://app.example.com:8443",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://127.10.20.30",
  "http://[::1]:3000",
];

/** Rejected in every mode: not an http(s) origin. */
const REJECTED_ANYWHERE = [
  "",
  "devresponse",
  "app.example.com",
  "//app.example.com",
  "httsp://demo.devresponse.ca",
  "ftp://app.example.com",
  "file:///etc/passwd",
  "javascript:alert(1)",
  "https:/app.example.com",
  "https:app.example.com",
  "https://app.example.com/path",
  "https://app.example.com/api/auth/",
  "https://app.example.com?x=1",
  "https://app.example.com?",
  "https://app.example.com#top",
  "https://app.example.com/#",
  "https://user:secret@app.example.com",
  "https://app.example.com:443",
  " https://app.example.com",
  "https://app.example.com ",
  "http://127.1:3000",
];

/** Accepted in development, refused in production (plain http off loopback). */
const HTTP_OFF_LOOPBACK = [
  "http://app.example.com",
  "http://devresponse.local:3000",
  "http://10.0.0.5:3000",
  "http://localhost.evil.example",
  "http://127.0.0.1.nip.io",
];

/** Tolerated by the lenient rule only: the app re-parses or trims these where it builds a URL. */
const LENIENT_ONLY = [
  "https://app.example.com/",
  "HTTPS://App.Example.com",
  "https://App.Example.com/",
];

const ALL_VECTORS = [
  ...ACCEPTED_ANYWHERE,
  ...REJECTED_ANYWHERE,
  ...HTTP_OFF_LOOPBACK,
  ...LENIENT_ONLY,
];
const MODES = [
  { production: false, exact: false },
  { production: false, exact: true },
  { production: true, exact: false },
  { production: true, exact: true },
] as const;

describe("httpOriginProblem (F-22)", () => {
  it.each(MODES)("accepts a plain origin and a loopback http origin (%o)", (mode) => {
    for (const value of ACCEPTED_ANYWHERE) {
      expect(httpOriginProblem(value, mode), value).toBeNull();
    }
  });

  it.each(MODES)("rejects anything that is not an http(s) origin (%o)", (mode) => {
    for (const value of REJECTED_ANYWHERE) {
      expect(httpOriginProblem(value, mode), JSON.stringify(value)).not.toBeNull();
    }
  });

  it("names the scheme that was wrong, so an operator can spot httsp:", () => {
    expect(httpOriginProblem("httsp://demo.devresponse.ca", { production: true })).toMatch(
      /http: or https: scheme, not "httsp:"/,
    );
  });

  it("allows plain http off loopback only outside production", () => {
    for (const value of HTTP_OFF_LOOPBACK) {
      expect(httpOriginProblem(value, { production: false }), value).toBeNull();
      expect(httpOriginProblem(value, { production: true }), value).toMatch(
        /must use https: in production/,
      );
    }
  });

  it("keeps loopback http legal in production (next build placeholders, CI's next start)", () => {
    for (const value of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      expect(httpOriginProblem(value, { production: true, exact: true }), value).toBeNull();
    }
  });

  it("tolerates a trailing slash and a capitalised host only when the value is not exact", () => {
    for (const value of LENIENT_ONLY) {
      expect(httpOriginProblem(value, { production: true }), value).toBeNull();
      expect(httpOriginProblem(value, { production: true, exact: true }), value).not.toBeNull();
    }
  });

  it("tells an operator to DROP a trailing slash on an exact value, not that it is malformed", () => {
    expect(
      httpOriginProblem("https://demo.devresponse.ca/", { production: true, exact: true }),
    ).toMatch(
      /must not end with "\/".*drop the trailing slash \(https:\/\/demo\.devresponse\.ca\)/,
    );
  });

  it("never echoes credentials from a rejected value", () => {
    const problem = httpOriginProblem("https://user:secret@app.example.com", { production: true });
    expect(problem).not.toContain("secret");
    expect(problem).toContain("https://app.example.com");
  });
});

describe("drk-deploy's copy of the origin rule stays in step with the kit's (F-22)", () => {
  it.each(MODES)("returns the same verdict AND sentence for every vector (%o)", (mode) => {
    for (const value of ALL_VECTORS) {
      expect(cliHttpOriginProblem(value, mode), JSON.stringify(value)).toBe(
        httpOriginProblem(value, mode),
      );
    }
  });

  it("exercises every rejection branch (completeness guard for the vectors above)", () => {
    // A parity check only pins what its vectors reach: if a branch is added
    // and no vector hits it, the two copies could drift there unnoticed.
    const branches = [
      /^must be an absolute http\(s\) origin/,
      /^must use the http: or https: scheme/,
      /^must not end with "\/"/,
      /^must be written exactly as an origin/,
      /^must be an origin,/,
      /^must use https: in production/,
    ];
    const sentences = new Set<string>();
    for (const mode of MODES) {
      for (const value of ALL_VECTORS) {
        const problem = httpOriginProblem(value, mode);
        if (problem) sentences.add(problem);
      }
    }
    for (const branch of branches) {
      expect(
        [...sentences].some((s) => branch.test(s)),
        String(branch),
      ).toBe(true);
    }
    for (const sentence of sentences) {
      expect(
        branches.some((b) => b.test(sentence)),
        `unlisted branch: ${sentence}`,
      ).toBe(true);
    }
  });

  it("applies the production rule to the kit's BETTER_AUTH_URL and the exact rule to its issuer", () => {
    const authUrl = cliSpecFor("BETTER_AUTH_URL")?.validate;
    const issuer = cliSpecFor("SSO_HANDOFF_ISSUER")?.validate;
    expect(authUrl).toBeDefined();
    expect(issuer).toBeDefined();
    for (const value of ALL_VECTORS) {
      expect(authUrl!(value), value).toBe(httpOriginProblem(value, { production: true }));
      expect(issuer!(value), value).toBe(
        httpOriginProblem(value, { production: true, exact: true }),
      );
    }
  });
});

describe("isLoopbackHost / splitEnvList", () => {
  it("recognises only real loopback hosts", () => {
    for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.255.0.9", "[::1]"]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of [
      "localhost.evil.example",
      "127.0.0.1.nip.io",
      "10.0.0.1",
      "[::2]",
      "0.0.0.0",
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it("trims entries and drops blanks", () => {
    expect(splitEnvList(" https://a.example , ,https://b.example ")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
    expect(splitEnvList(undefined)).toEqual([]);
  });
});

describe("cookieDomainProblem (F-22)", () => {
  const DEMO = "https://demo.devresponse.ca";

  it("accepts the host itself or a parent domain of it, with or without the leading dot", () => {
    for (const domain of [".devresponse.ca", "devresponse.ca", "demo.devresponse.ca"]) {
      expect(cookieDomainProblem(domain, DEMO, { production: true }), domain).toBeNull();
    }
    // The local SSO rig: http://devresponse.local:3000 under .devresponse.local.
    expect(
      cookieDomainProblem(".devresponse.local", "http://devresponse.local:3000", {
        production: false,
      }),
    ).toBeNull();
  });

  it("refuses a domain that does not cover BETTER_AUTH_URL's host (the cookie would be dropped)", () => {
    for (const domain of [".devresponse.com", ".mo.devresponse.ca", "other.devresponse.ca"]) {
      expect(cookieDomainProblem(domain, DEMO, { production: true }), domain).toMatch(
        /must be BETTER_AUTH_URL's host \(demo\.devresponse\.ca\) or a parent domain/,
      );
    }
    // A suffix match without a label boundary is not a parent domain.
    expect(
      cookieDomainProblem("example.com", "https://evil-example.com", { production: true }),
    ).not.toBeNull();
  });

  it("refuses a public suffix even when the host sits under it", () => {
    expect(cookieDomainProblem(".ca", DEMO, { production: true })).toMatch(/public suffix/);
    expect(cookieDomainProblem(".com", "https://app.example.com", { production: true })).toMatch(
      /public suffix/,
    );
    expect(
      cookieDomainProblem(".co.uk", "https://app.example.co.uk", { production: true }),
    ).toMatch(/public suffix/);
    expect(
      cookieDomainProblem("github.io", "https://someone.github.io", { production: true }),
    ).toMatch(/public suffix/);
  });

  it("refuses a value that is not a host name, and an IP address", () => {
    expect(cookieDomainProblem("https://devresponse.ca", DEMO, { production: true })).toMatch(
      /not a plain host name/,
    );
    expect(cookieDomainProblem("*.devresponse.ca", DEMO, { production: true })).toMatch(
      /not a plain host name/,
    );
    expect(cookieDomainProblem(" ", DEMO, { production: true })).toMatch(/not a plain host name/);
    expect(
      cookieDomainProblem("127.0.0.1", "http://127.0.0.1:3000", { production: false }),
    ).toMatch(/IP address/);
  });

  it("tolerates localhost outside production only", () => {
    expect(
      cookieDomainProblem("localhost", "http://localhost:3000", { production: false }),
    ).toBeNull();
    expect(cookieDomainProblem("localhost", "http://localhost:3000", { production: true })).toMatch(
      /localhost is not accepted in production/,
    );
  });

  it("accepts the domain in any letter case, with or without ONE leading dot", () => {
    // A browser lowercases the Domain attribute and strips one leading dot
    // (RFC 6265 section 5.2.3), so these all reach it as devresponse.ca.
    for (const domain of ["DevResponse.CA", ".DEVRESPONSE.ca", "Demo.DevResponse.ca"]) {
      expect(cookieDomainProblem(domain, DEMO, { production: true }), domain).toBeNull();
    }
  });

  it("refuses a spelling the browser would not read as the checked domain", () => {
    // auth.ts hands Better Auth the RAW value and it is written verbatim as
    // `Domain=<value>`. Edge (Chromium) drops the cookie for the first three
    // on demo.devresponse.ca, although their normalised form covers the host.
    // Surrounding whitespace is refused as it is for the origin variables: a
    // browser trims spaces, but a newline makes the whole Set-Cookie header
    // invalid (`Headers.append` throws), so every sign-in would 500.
    for (const domain of [
      "devresponse.ca.",
      ".devresponse.ca.",
      "..devresponse.ca",
      " .devresponse.ca",
      ".devresponse.ca ",
      "devresponse.ca\n",
    ]) {
      expect(cookieDomainProblem(domain, DEMO, { production: true }), JSON.stringify(domain)).toBe(
        "must be written as devresponse.ca or .devresponse.ca, with one optional leading dot, no trailing dot and no surrounding spaces: it is sent to the browser exactly as written, and a browser drops a cookie whose domain has a trailing or doubled dot",
      );
    }
  });

  it("leaves an unparseable BETTER_AUTH_URL to that variable's own rule", () => {
    expect(cookieDomainProblem(".devresponse.ca", "not a url", { production: true })).toBeNull();
  });
});

describe("ed25519PrivateJwkProblem, the key SHAPE (F-22, review #50)", () => {
  const exportJwk = () =>
    generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }) as Record<string, string>;
  const JWK = exportJwk();
  const RAW = JSON.stringify(JWK);
  // RFC 8037 Appendix A test vector: a real, consistent pair. Both members
  // hold a `_`, so they also carry the base64url-only alphabet.
  const RFC_X = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
  const RFC_D = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";
  const RFC = { kty: "OKP", crv: "Ed25519", x: RFC_X, d: RFC_D };
  const RFC8037 = JSON.stringify(RFC);
  const D_SHAPE =
    /^has a d member that is not 43 unpadded base64url characters.*truncated or corrupted/;
  const X_SHAPE = /^has an x member that is not 43 unpadded base64url characters/;

  it("accepts a real key, the RFC 8037 vector, and extra metadata members", () => {
    expect(ed25519PrivateJwkProblem(RAW)).toBeNull();
    expect(ed25519PrivateJwkProblem(RFC8037)).toBeNull();
    expect(
      ed25519PrivateJwkProblem(JSON.stringify({ ...JWK, alg: "EdDSA", kid: "k1", use: "sig" })),
    ).toBeNull();
  });

  it("leaves the x/d pairing to the boot import (env-signing-keys.server.ts)", () => {
    // Two well-formed halves from different keys have the right shape: only
    // an import can tell, and this module must stay free of node:crypto.
    expect(ed25519PrivateJwkProblem(JSON.stringify({ ...JWK, x: exportJwk().x }))).toBeNull();
  });

  const BAD_KEYS: ReadonlyArray<readonly [string, string, RegExp]> = [
    ["a trailing quote after the JSON", `${RAW}"`, /not valid JSON/],
    ["a truncated value", RAW.slice(0, -10), /not valid JSON/],
    ["the JSON quoted as a string", JSON.stringify(RAW), /a JSON object/],
    ["a JSON array", "[]", /a JSON object/],
    ["JSON null", "null", /a JSON object/],
    ["a truncated d", JSON.stringify({ ...JWK, d: JWK.d!.slice(0, -4) }), D_SHAPE],
    ["a d one character short", JSON.stringify({ ...JWK, d: JWK.d!.slice(0, -1) }), D_SHAPE],
    ["a d one character long", JSON.stringify({ ...JWK, d: `${JWK.d}A` }), D_SHAPE],
    ["a padded d", JSON.stringify({ ...JWK, d: `${JWK.d}=` }), D_SHAPE],
    [
      "a d in the standard alphabet (/)",
      JSON.stringify({ ...RFC, d: RFC_D.replace("_", "/") }),
      D_SHAPE,
    ],
    [
      "a d in the standard alphabet (+)",
      JSON.stringify({ ...RFC, d: RFC_D.replace("_", "+") }),
      D_SHAPE,
    ],
    ["a d with a trailing newline", JSON.stringify({ ...JWK, d: `${JWK.d}\n` }), D_SHAPE],
    ["an empty d", JSON.stringify({ ...JWK, d: "" }), D_SHAPE],
    ["a stray quote inside x", JSON.stringify({ ...JWK, x: `${JWK.x}"` }), X_SHAPE],
    ["a truncated x", JSON.stringify({ ...JWK, x: JWK.x!.slice(0, -4) }), X_SHAPE],
    ["a padded x", JSON.stringify({ ...JWK, x: `${JWK.x}=` }), X_SHAPE],
    [
      "an x in the standard alphabet (/)",
      JSON.stringify({ ...RFC, x: RFC_X.replace("_", "/") }),
      X_SHAPE,
    ],
    [
      "an x in the standard alphabet (+)",
      JSON.stringify({ ...RFC, x: RFC_X.replace("_", "+") }),
      X_SHAPE,
    ],
    ["the wrong curve", JSON.stringify({ ...JWK, crv: "X25519" }), /kty OKP, crv Ed25519/],
    ["an RSA key", JSON.stringify({ kty: "RSA", n: "x", e: "AQAB", d: "y" }), /kty OKP/],
    ["a public-only JWK", JSON.stringify({ kty: "OKP", crv: "Ed25519", x: JWK.x }), /private d/],
    ["no x at all", JSON.stringify({ kty: "OKP", crv: "Ed25519", d: JWK.d }), /public x/],
  ];

  it.each(BAD_KEYS)("refuses %s", (_label, raw, expected) => {
    expect(ed25519PrivateJwkProblem(raw)).toMatch(expected);
  });

  it("exercises every rejection branch (completeness guard for BAD_KEYS)", () => {
    const branches = [
      /^must be a JSON-encoded Ed25519 private JWK \(it is not valid JSON\)$/,
      /^must be a JSON-encoded Ed25519 private JWK \(a JSON object\)$/,
      /^must be an Ed25519 JWK/,
      /^must carry both the private d and the public x member$/,
      D_SHAPE,
      X_SHAPE,
    ];
    const sentences = new Set(BAD_KEYS.map(([, raw]) => ed25519PrivateJwkProblem(raw) ?? ""));
    for (const branch of branches) {
      expect(
        [...sentences].some((s) => branch.test(s)),
        String(branch),
      ).toBe(true);
    }
    for (const sentence of sentences) {
      expect(
        branches.some((b) => b.test(sentence)),
        `unlisted branch: ${sentence}`,
      ).toBe(true);
    }
  });

  it("never quotes key material in its sentences", () => {
    const d = JWK.d!;
    for (const raw of [
      JSON.stringify({ ...JWK, d: d.slice(0, -4) }),
      JSON.stringify({ ...JWK, d: `${d}=` }),
      JSON.stringify({ ...JWK, x: `${JWK.x}"` }),
      `${RAW}"`,
    ]) {
      const problem = ed25519PrivateJwkProblem(raw) ?? "";
      expect(problem).not.toBe("");
      expect(problem).not.toContain(d.slice(0, 12));
      expect(problem).not.toContain(JWK.x!.slice(0, 12));
    }
  });
});
