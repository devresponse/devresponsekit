# Better Auth Schema Notes

This file documents the Better Auth database tables that are managed by
the Better Auth migration runner, not by the application SQL migrations.

## Running Better Auth migrations

```bash
pnpm db:auth:migrate
```

This runs `pnpm dlx auth@latest migrate --config src/lib/auth.ts --yes`,
which applies the Better Auth core schema to the database.

## Tables managed by Better Auth

| Table name         | Purpose                                                      |
|--------------------|--------------------------------------------------------------|
| `user`             | Core user record created on first sign-in/sign-up.           |
| `session`          | Active session records. Rolling 8-hour TTL.                  |
| `account`          | Social provider account links (Google, Microsoft, GitHub).   |
| `verification`     | Email verification and password-reset tokens.                |

## Account linking policy

Accounts are linked by **verified email only** (per §2). The Better Auth
`socialSignIn` hook checks for an existing `user` row with the same
verified email before creating a new one.

## Application vs Better Auth tables

All application concerns — organization memberships, roles, permissions,
app status, SSO nonces, and audit events — live in `app_*` tables managed
by `0001-app-core.sql`. The Better Auth tables above are left untouched
by application code except for reading `better_auth_user_id` to join to
the `app_users` table.
