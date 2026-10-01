import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

/**
 * A SCRAM-SHA-256 password verifier, computed client-side (DEP3).
 *
 * `pnpm db:runtime-login` sets the runtime login's password with
 * `create role … password '<verifier>'`. Postgres stores a string that
 * already has this shape as it is, so the plaintext never reaches the server,
 * and a `log_statement = 'ddl'` line, `pg_stat_statements` or a provider's
 * query history holds only what `pg_authid.rolpassword` would hold anyway.
 *
 * The format is Postgres's (`src/common/scram-common.c`, RFC 5802 / 7677):
 *
 *   SCRAM-SHA-256$<iterations>:<base64 salt>$<base64 StoredKey>:<base64 ServerKey>
 *
 *   SaltedPassword = PBKDF2-HMAC-SHA256(password, salt, iterations, 32)
 *   ClientKey      = HMAC(SaltedPassword, "Client Key")
 *   StoredKey      = SHA256(ClientKey)
 *   ServerKey      = HMAC(SaltedPassword, "Server Key")
 *
 * The password is not SASLprep-normalised: the command accepts only
 * `[A-Za-z0-9_-]`, which SASLprep leaves unchanged.
 */

/** Postgres's default iteration count (`scram_iterations`). */
export const SCRAM_ITERATIONS = 4096;
/** Postgres's salt length. */
export const SCRAM_SALT_BYTES = 16;

/** The keys a verifier is made of. */
export interface ScramKeys {
  saltedPassword: Buffer;
  clientKey: Buffer;
  storedKey: Buffer;
  serverKey: Buffer;
}

const hmac = (key: Buffer, text: string) => createHmac("sha256", key).update(text).digest();

/** SaltedPassword and the three keys derived from it. */
export function deriveScramKeys(password: string, salt: Buffer, iterations: number): ScramKeys {
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error("SCRAM iterations must be a positive integer");
  }
  const saltedPassword = pbkdf2Sync(Buffer.from(password, "utf8"), salt, iterations, 32, "sha256");
  const clientKey = hmac(saltedPassword, "Client Key");
  return {
    saltedPassword,
    clientKey,
    storedKey: createHash("sha256").update(clientKey).digest(),
    serverKey: hmac(saltedPassword, "Server Key"),
  };
}

/**
 * The verifier for `password`. The salt is 16 random bytes unless given (the
 * known-answer test fixes it).
 */
export function scramSha256Verifier(
  password: string,
  options: { salt?: Buffer; iterations?: number } = {},
): string {
  const salt = options.salt ?? randomBytes(SCRAM_SALT_BYTES);
  const iterations = options.iterations ?? SCRAM_ITERATIONS;
  const { storedKey, serverKey } = deriveScramKeys(password, salt, iterations);
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}
