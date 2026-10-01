-- Removes a column nothing reads any more, with no marker saying so.
alter table app_users drop column if exists legacy_name;
