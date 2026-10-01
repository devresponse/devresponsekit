import { databaseIdentity, parsePostgresUrl, sameDatabase } from "./migration-target.js";

/**
 * Which database production uses, as its own build said (DEP4).
 *
 * `drk-deploy db:runtime-login` creates a login in the database the owner URL
 * names, then points production at it. Checking that URL against production
 * the way `migrate` does (F-47) needs production's `DATABASE_URL`, which the
 * kit stores `sensitive`: `vercel pull` hands it back as a placeholder. But
 * every production build runs the kit's schema gate (DEP1), which prints one
 * line naming the database it connected to:
 *
 *   [deploy-gate] target host=… port=… database=… schema=… user=… runtime=owner|non-owner
 *
 * That line, read from the serving deployment's build log, is the reference:
 * host, port and database as the URL writes them (the database percent-escaped),
 * the schema, and the user the database reported. `formatTargetLine` in the
 * kit's src/db/deploy-gate.ts writes it, and the kit's
 * tests/unit/deploy-gate.test.ts pins its format; this is the reader. Pure.
 */

/** What one target line says. */
export interface GateTarget {
  host: string;
  port: string;
  /** As the URL writes it: percent-escapes kept, "" when the URL named none. */
  database: string;
  schema: string;
  /** The user the database reported (`current_user`), not percent-escaped. */
  user: string;
  runtime: "owner" | "non-owner";
}

/**
 * DEP1's line, whole. The database may be empty (a URL with no path), which
 * the writer prints as `database=` and its pin allows.
 */
const TARGET_LINE =
  /^\[deploy-gate\] target host=(\S+) port=(\d+) database=(\S*) schema=(\S+) user=(\S+) runtime=(owner|non-owner)$/;

/**
 * The LAST target line in `lines`, or null when there is none. Each entry may
 * hold several lines, and a line's trailing whitespace (a carriage return) is
 * ignored; anything else that does not match exactly is skipped, never read
 * in part. The last one wins because a build that retried prints its
 * verdict about the connection it ended on.
 */
export function parseGateTargetLine(lines: Iterable<string>): GateTarget | null {
  let found: GateTarget | null = null;
  for (const entry of lines) {
    for (const line of entry.split("\n")) {
      const match = TARGET_LINE.exec(line.trimEnd());
      if (!match) continue;
      const [, host, port, database, schema, user, runtime] = match as unknown as [
        string,
        string,
        string,
        string,
        string,
        string,
        "owner" | "non-owner",
      ];
      found = { host, port, database, schema, user, runtime };
    }
  }
  return found;
}

/**
 * The line's database as a URL, for {@link databaseIdentity}: the user and the
 * database are what the gate connected as and to, with no password. Null when
 * the parts do not make a URL.
 */
export function gateTargetUrl(target: GateTarget): URL | null {
  const host = target.host.includes(":") && !target.host.startsWith("[") ? `[${target.host}]` : target.host;
  return parsePostgresUrl(
    `postgresql://${encodeURIComponent(target.user)}@${host}:${target.port}/${target.database}`,
  );
}

/**
 * Whether `owner` (the owner's DIRECT URL) reaches the database the gate line
 * names, by the rules `migrate` compares URLs with (`databaseIdentity`): host
 * with Neon's `-pooler` removed, port, and database name. The gate usually
 * connects through the pooler and the owner URL never does, so the two hosts
 * differ by exactly that suffix.
 */
export function ownerMatchesGateTarget(owner: URL, target: GateTarget): boolean {
  const reference = gateTargetUrl(target);
  return reference !== null && sameDatabase(databaseIdentity(owner), databaseIdentity(reference));
}

/**
 * Every line of text in a `getDeploymentEvents` answer, oldest first. The
 * endpoint answers a list of events, each carrying its text either at the
 * top level or in `payload` depending on its kind; anything without text is
 * left out. An answer that is not a list (a single event) is read as one.
 */
export function deploymentEventTexts(response: unknown): string[] {
  const events = Array.isArray(response) ? response : [response];
  const texts: string[] = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const { text, payload } = event as { text?: unknown; payload?: { text?: unknown } };
    const value = typeof text === "string" ? text : typeof payload?.text === "string" ? payload.text : null;
    if (value !== null) texts.push(value);
  }
  return texts;
}
