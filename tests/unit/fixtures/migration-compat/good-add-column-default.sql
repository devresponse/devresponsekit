-- Additive: older builds never name the column, and the default fills it for them.
alter table app_users add column if not exists tier text not null default 'standard';
create index if not exists idx_app_users_tier on app_users (tier);
