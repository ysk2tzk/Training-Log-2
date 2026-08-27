do $$
declare
  constraint_def text;
  base_expr text;
begin
  select pg_get_constraintdef(c.oid)
    into constraint_def
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'training_log'
    and c.conname = 'log_source_chk';

  if constraint_def is null then
    raise exception 'Constraint public.log_source_chk was not found';
  end if;

  if constraint_def ilike '%suunto%' then
    raise notice 'Constraint already allows suunto: %', constraint_def;
    return;
  end if;

  base_expr := regexp_replace(constraint_def, '^CHECK \(\((.*)\)\)$', '\1');
  base_expr := regexp_replace(base_expr, '^CHECK \((.*)\)$', '\1');

  execute 'alter table public.training_log drop constraint log_source_chk';
  execute format(
    'alter table public.training_log add constraint log_source_chk check ((%s) or (source = %L))',
    base_expr,
    'suunto'
  );
end
$$;
