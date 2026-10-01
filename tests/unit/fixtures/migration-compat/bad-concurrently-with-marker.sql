-- compat: expand — a plain additive index, built without blocking writers on a large table.
create index concurrently if not exists idx_app_users_tier on app_users (tier);
