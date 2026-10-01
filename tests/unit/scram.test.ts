import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SCRAM_ITERATIONS,
  SCRAM_SALT_BYTES,
  deriveScramKeys,
  scramSha256Verifier,
} from "@/db/scram";

/**
 * The client-side SCRAM-SHA-256 verifier `pnpm db:runtime-login` hands to
 * `create role … password` (DEP3). The known answer is RFC 7677's own
 * exchange (§3: user "user", password "pencil"): keys derived here must
 * reproduce the client proof and the server signature the RFC prints, which
 * pins SaltedPassword, ClientKey, StoredKey and ServerKey at once. That
 * Postgres accepts the verifier is proven by tests/db/runtime-login.db.test.ts,
 * which signs in with it.
 */

const RFC_SALT = Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64");
const CLIENT_FIRST_BARE = "n=user,r=rOprNGfwEbeRWgbNEkqO";
const SERVER_FIRST =
  "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096";
const CLIENT_FINAL_BARE = "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";
const AUTH_MESSAGE = `${CLIENT_FIRST_BARE},${SERVER_FIRST},${CLIENT_FINAL_BARE}`;
const RFC_PROOF = "dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=";
const RFC_SERVER_SIGNATURE = "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=";

const hmac = (key: Buffer, text: string) => createHmac("sha256", key).update(text).digest();

describe("SCRAM-SHA-256 verifier (DEP3)", () => {
  it("reproduces RFC 7677's client proof and server signature", () => {
    const keys = deriveScramKeys("pencil", RFC_SALT, 4096);
    const clientSignature = hmac(keys.storedKey, AUTH_MESSAGE);
    const proof = Buffer.from(keys.clientKey.map((byte, i) => byte ^ clientSignature[i]!));
    expect(proof.toString("base64")).toBe(RFC_PROOF);
    expect(hmac(keys.serverKey, AUTH_MESSAGE).toString("base64")).toBe(RFC_SERVER_SIGNATURE);
  });

  it("writes Postgres's format with the given salt and the default 4096 iterations", () => {
    const keys = deriveScramKeys("pencil", RFC_SALT, 4096);
    expect(scramSha256Verifier("pencil", { salt: RFC_SALT })).toBe(
      `SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$${keys.storedKey.toString("base64")}:${keys.serverKey.toString("base64")}`,
    );
    expect(SCRAM_ITERATIONS).toBe(4096);
  });

  it("salts each verifier with 16 fresh random bytes, and never contains the password", () => {
    const password = "a-runtime-login-password-of-32-chars";
    const a = scramSha256Verifier(password);
    const b = scramSha256Verifier(password);
    const shape =
      /^SCRAM-SHA-256\$4096:([A-Za-z0-9+/]{22}==)\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/;
    expect(a).toMatch(shape);
    expect(Buffer.from(shape.exec(a)![1]!, "base64")).toHaveLength(SCRAM_SALT_BYTES);
    expect(a).not.toBe(b);
    expect(a).not.toContain(password);
    expect(scramSha256Verifier(password, { iterations: 8192 })).toMatch(/^SCRAM-SHA-256\$8192:/);
  });

  it("refuses an iteration count that is not a positive integer", () => {
    for (const iterations of [0, -1, 1.5, Number.NaN]) {
      expect(() => deriveScramKeys("x", RFC_SALT, iterations)).toThrow(
        "SCRAM iterations must be a positive integer",
      );
    }
  });
});
