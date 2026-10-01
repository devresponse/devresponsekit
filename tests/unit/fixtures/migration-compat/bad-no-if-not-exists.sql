-- Fails on a re-run after a partial apply.
create table app_widgets (
  id uuid primary key default gen_random_uuid(),
  name text not null
);
