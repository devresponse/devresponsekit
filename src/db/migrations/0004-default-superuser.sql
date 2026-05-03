-- 0004-default-superuser.sql
--
-- Sets up a default `superuser` access level and wires the canonical
-- local admin (`admin@devresponse.local`) to it.
--
-- Goals:
--
--   1. Guarantee a `superuser` role exists on the default organization
--      that holds *every* permission currently registered in
--      `app_permissions`. This makes `superuser` act as a true
--      "access-to-everything" level — it implicitly covers the
--      `administrator` (`admin`) and `admin.platform` capabilities by
--      virtue of holding all of their permission keys.
--
--   2. If a Better Auth identity for `admin@devresponse.local` already
--      exists in the vendor `"user"` table, ensure the matching
--      application-side records are present and active:
--
--        - `app_users` row (status = 'active')
--        - `app_organization_memberships` on the default org
--          (status = 'active')
--        - `app_user_roles` assigning `admin`, `admin.platform`, and
--          the new `superuser` role
--
--      When the Better Auth user does NOT yet exist (which is the
--      normal case on a fresh install — the seed creates it after
--      migrations run), the role/permission scaffolding is still
--      applied, and the seed script (`src/db/seeds/seed-local.ts`)
--      handles the user-side wiring once the Better Auth user is
--      created.
--
-- Idempotent: every statement uses `if not exists` / `on conflict`
-- guards so re-running the migration (or running it against a database
-- that has already been seeded) is a no-op.

-- 1. Default organization (also created by the seed; created here so
--    the migration is self-contained and works even if run before any
--    seed has been executed).
insert into app_organizations (slug, name, status, is_default)
values ('default', 'Default Organization', 'active', true)
on conflict (slug) do nothing;

-- 2. Marker permission for the superuser access level. It is not
--    individually checked at runtime (the role's effectiveness comes
--    from holding every other permission), but having a stable key
--    makes the access level discoverable in admin tooling and audit.
insert into app_permissions (key, description)
values (
  'superuser',
  'Superuser access level — full unrestricted access to every part of the application'
)
on conflict (key) do nothing;

-- 3. Superuser role on the default organization.
insert into app_roles (organization_id, key, name, description)
select
  o.id,
  'superuser',
  'Superuser',
  'Default superuser access level. Holds every permission, including all administrator capabilities.'
from app_organizations o
where o.slug = 'default'
on conflict (organization_id, key) do nothing;

-- 4. Grant the superuser role every permission currently registered in
--    `app_permissions`. New permissions added by later migrations or by
--    the seed will need to be granted explicitly (the seed re-applies
--    this grant for the canonical catalog), but at minimum the
--    superuser is born holding everything that exists at the time it
--    is created.
insert into app_role_permissions (role_id, permission_id)
select r.id, p.id
from app_roles r
join app_organizations o on o.id = r.organization_id
cross join app_permissions p
where o.slug = 'default'
  and r.key = 'superuser'
on conflict do nothing;

-- 5. If a Better Auth identity for the canonical local admin already
--    exists, provision the matching application-side rows. This is
--    wrapped in a DO block because:
--
--      - The Better Auth `"user"` table is created by
--        `pnpm db:auth:migrate`. We must not fail when it is absent
--        (e.g., during isolated SQL replay).
--      - The Better Auth user row itself only exists after the seed
--        has run. When it does, this block backfills everything; when
--        it does not, the seed handles the same wiring later.
do $$
declare
  v_default_org_id uuid;
  v_admin_role_id uuid;
  v_platform_role_id uuid;
  v_superuser_role_id uuid;
  v_better_auth_user_id text;
  v_better_auth_email text;
  v_better_auth_name text;
  v_app_user_id uuid;
  v_has_user_table boolean;
  v_has_role_column boolean;
begin
  select exists (
    select 1
    from information_schema.tables
    where table_schema = current_schema()
      and table_name = 'user'
  ) into v_has_user_table;

  if not v_has_user_table then
    raise notice '[0004-default-superuser] Better Auth "user" table not found; skipping default-admin provisioning. Run pnpm db:auth:migrate (Better Auth schema) and then pnpm db:seed to create admin@devresponse.local; the seed will assign the superuser role.';
    return;
  end if;

  execute $sql$
    select id, email, name
    from "user"
    where lower(email) = lower('admin@devresponse.local')
    limit 1
  $sql$
  into v_better_auth_user_id, v_better_auth_email, v_better_auth_name;

  if v_better_auth_user_id is null then
    raise notice '[0004-default-superuser] Better Auth user admin@devresponse.local does not exist yet; superuser role created but user-side wiring will be completed by pnpm db:seed.';
    return;
  end if;

  select id into v_default_org_id
  from app_organizations
  where slug = 'default';

  select id into v_admin_role_id
  from app_roles
  where organization_id = v_default_org_id and key = 'admin';

  select id into v_platform_role_id
  from app_roles
  where organization_id = v_default_org_id and key = 'admin.platform';

  select id into v_superuser_role_id
  from app_roles
  where organization_id = v_default_org_id and key = 'superuser';

  insert into app_users (
    better_auth_user_id,
    primary_email,
    display_name,
    status,
    status_reason,
    preferred_locale
  )
  values (
    v_better_auth_user_id,
    v_better_auth_email,
    coalesce(v_better_auth_name, 'Local Admin'),
    'active',
    null,
    'en'
  )
  on conflict (better_auth_user_id) do update set
    primary_email = excluded.primary_email,
    display_name = coalesce(excluded.display_name, app_users.display_name),
    status = 'active',
    status_reason = null,
    updated_at = now()
  returning id into v_app_user_id;

  -- Mirror the Better Auth admin-plugin role flag when the column
  -- exists, so the vendor admin endpoints recognise the user as well.
  select exists (
    select 1
    from information_schema.columns
    where table_schema = current_schema()
      and table_name = 'user'
      and column_name = 'role'
  ) into v_has_role_column;

  if v_has_role_column then
    execute $sql$ update "user" set role = 'admin' where id = $1 $sql$
      using v_better_auth_user_id;
  end if;

  insert into app_organization_memberships (
    organization_id,
    app_user_id,
    status,
    source_provider,
    provider_organization_key
  )
  values (v_default_org_id, v_app_user_id, 'active', 'email', 'default')
  on conflict (organization_id, app_user_id) do update set
    status = 'active',
    source_provider = excluded.source_provider,
    provider_organization_key = excluded.provider_organization_key,
    updated_at = now();

  if v_admin_role_id is not null then
    insert into app_user_roles (app_user_id, organization_id, role_id)
    values (v_app_user_id, v_default_org_id, v_admin_role_id)
    on conflict do nothing;
  end if;

  if v_platform_role_id is not null then
    insert into app_user_roles (app_user_id, organization_id, role_id)
    values (v_app_user_id, v_default_org_id, v_platform_role_id)
    on conflict do nothing;
  end if;

  if v_superuser_role_id is not null then
    insert into app_user_roles (app_user_id, organization_id, role_id)
    values (v_app_user_id, v_default_org_id, v_superuser_role_id)
    on conflict do nothing;
  end if;

  raise notice '[0004-default-superuser] provisioned admin@devresponse.local with admin + admin.platform + superuser roles on the default organization.';
end
$$;
