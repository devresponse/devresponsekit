-- An older build inserts users without `tier`, so every one of its inserts fails with 23502.
alter table app_users add column if not exists tier text not null;
