import "dotenv/config";
import { Pool } from "pg";

/**
 * Direct database access for e2e flows that must follow a LIVE one-time link
 * (password reset, invitation accept).
 *
 * The admin outbox API deliberately no longer carries those links: the stored
 * `body_html` / `body_text` are redacted at insert time (review #21) so an org
 * admin can never read a co-member's reset URL. The unredacted rendering
 * survives only in `app_outbox.delivery_payload` — a DB-only column no route
 * selects — which is exactly the trust boundary an e2e run sits inside (the CI
 * job owns the Postgres service; locally `.env` is loaded via dotenv, which
 * never overrides variables already in the environment).
 *
 * Mirrors `src/db/schema-config.ts`: every table lives in `DB_SCHEMA`
 * (default `auth`), applied through the libpq `search_path` option.
 */
const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/i;

let pool: Pool | undefined;

function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set: the e2e helper reads the outbox delivery payload straight from Postgres.",
    );
  }
  const schema = (process.env.DB_SCHEMA ?? "auth").trim();
  if (!SCHEMA_RE.test(schema)) throw new Error(`Invalid DB_SCHEMA "${schema}"`);
  pool = new Pool({
    connectionString,
    options: `-c search_path="${schema}",public`,
    max: 2,
  });
  return pool;
}

interface DeliveryPayload {
  subject: string;
  html: string;
  text: string | null;
}

/**
 * Returns the first match of `pattern` (its group 1, or the whole match) in
 * the UNREDACTED delivery payload of the newest outbox row sent to `to` with
 * `templateKey`, or undefined when no such row / payload / match exists yet
 * (poll on it — the row is written by the app process).
 */
export async function readOutboxDeliveryLink(input: {
  to: string;
  templateKey: string;
  pattern: RegExp;
}): Promise<string | undefined> {
  const res = await getPool().query<{ delivery_payload: DeliveryPayload | null }>(
    `select delivery_payload
       from app_outbox
      where to_email = $1 and template_key = $2
      order by created_at desc
      limit 1`,
    [input.to, input.templateKey],
  );
  const payload = res.rows[0]?.delivery_payload;
  if (!payload) return undefined;
  for (const candidate of [payload.text, payload.html]) {
    const match = candidate?.match(input.pattern);
    if (match) return match[1] ?? match[0];
  }
  return undefined;
}
