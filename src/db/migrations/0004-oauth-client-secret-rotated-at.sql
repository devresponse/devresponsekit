-- 0004-oauth-client-secret-rotated-at.sql
--
-- Outstanding-token revocation for OAuth clients (review #43). Every JWT now
-- carries a `cid` claim naming the credential it was minted from, and the
-- caller resolver re-reads that credential's status on every request. For an
-- API key, revoke AND rotate both flip the row to `revoked`, so the check
-- alone retires the key's tokens. Rotating an OAuth client's SECRET, however,
-- re-hashes in place — the row stays `active` — so without a rotation stamp a
-- token minted with the OLD secret would remain valid until `exp`.
--
-- `secret_rotated_at` is written by `rotateOauthClientSecret`; the resolver
-- refuses a token whose `iat` precedes it. Null (never rotated) means every
-- token from an active client is honoured, so existing rows need no backfill.
--
-- Idempotent: `add column if not exists`.

alter table app_oauth_clients add column if not exists secret_rotated_at timestamptz;
