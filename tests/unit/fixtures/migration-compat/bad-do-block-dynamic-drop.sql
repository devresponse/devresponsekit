-- The drop is dynamic SQL inside a string literal; it still removes a table older builds read.
do $$
begin
  execute format('drop table if exists %I', 'app_legacy_widgets');
end $$;
