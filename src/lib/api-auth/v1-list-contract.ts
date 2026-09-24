/**
 * The query contract of the `/api/v1` list endpoints, declared ONCE (F-34).
 *
 * Both sides read it: the OpenAPI builder (`openapi.ts`) publishes each
 * list's `sort` and `filter[…]` parameters from it, which is also the
 * `inputSchema` the MCP gateway derives its tools from and validates
 * arguments against; and the route parses its query string against it with
 * `parseListQueryStrict`. A value the spec offers is therefore always one the
 * route accepts, and a value the route refuses is never one the spec offers.
 *
 * Pure (no `server-only`, no db): `openapi.ts` is imported by the export
 * script and the MCP deriver as well as by routes.
 */
import {
  APP_USER_STATUS_VALUES,
  AUDIT_OUTCOME_VALUES,
  CREDENTIAL_STATUS_VALUES,
} from "@/lib/status-values";

export interface V1ListContract {
  /**
   * Columns a `sort` directive may name (`field.asc` / `field.desc`). Empty:
   * the list publishes no `sort` parameter and refuses one.
   */
  sortFields: readonly string[];
  /** Whether the list applies `q` (and publishes it); `false` refuses one. */
  search: boolean;
  /**
   * The `filter[<name>]` parameters, in the order the spec lists them.
   * `values` is the closed vocabulary (the spec's `enum`); omit it for a
   * free-text exact match.
   */
  filters: Readonly<Record<string, { values?: readonly string[] }>>;
}

/** `GET /api/v1/users`. */
export const V1_USERS_LIST: V1ListContract = {
  sortFields: ["created_at", "primary_email", "display_name", "status"],
  search: true,
  filters: { status: { values: APP_USER_STATUS_VALUES } },
};

/** `GET /api/v1/audit-events`. */
export const V1_AUDIT_EVENTS_LIST: V1ListContract = {
  sortFields: ["created_at", "event_type", "outcome"],
  search: false,
  filters: { event_type: {}, outcome: { values: AUDIT_OUTCOME_VALUES } },
};

/**
 * `GET /api/v1/admin/api-keys` and `GET /api/v1/admin/oauth-clients`: no
 * `sort`, `q` or `filter[…]` at all. They take only their own scalar
 * parameters (`status`, and `appUserId` on api-keys), each at most once, so a
 * `filter[status]=revoked` in the form the other lists use is a 400 rather
 * than a list of every credential (F-34).
 */
export const V1_CREDENTIAL_LIST: V1ListContract = { sortFields: [], search: false, filters: {} };

export type CredentialStatus = (typeof CREDENTIAL_STATUS_VALUES)[number];

/**
 * The single `status` parameter of the two credential listings
 * (`/admin/api-keys`, `/admin/oauth-clients`): absent, or exactly one of
 * {@link CREDENTIAL_STATUS_VALUES}. Anything else is a failure the route
 * returns as a 400 (F-34): an unknown value used to be ignored, which listed
 * every credential under a filter the caller believed applied, and a
 * repeated one silently kept only the first.
 */
export function parseCredentialStatusParam(
  params: URLSearchParams,
): { ok: true; status: CredentialStatus | undefined } | { ok: false; detail: string } {
  const values = params.getAll("status");
  if (values.length === 0) return { ok: true, status: undefined };
  const [value] = values;
  const status = CREDENTIAL_STATUS_VALUES.find((s) => s === value);
  if (values.length > 1 || status === undefined) {
    return {
      ok: false,
      detail: `\`status\` is a single value, one of: ${CREDENTIAL_STATUS_VALUES.join(", ")}.`,
    };
  }
  return { ok: true, status };
}
