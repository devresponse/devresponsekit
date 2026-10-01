-- compat: contract — legacy_name has had no reader since #512 shipped in 2.1.0: the live build,
-- every build an Instant Rollback can restore, and each satellite at its deployed version select it nowhere.
alter table app_users drop column if exists legacy_name;
