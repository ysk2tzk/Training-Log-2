-- Run once in the Supabase SQL editor before deploying the application change.
-- The conditional block makes this safe to run again after the rename is complete.
do $$
begin
  if to_regclass('public.training_log') is null
    and to_regclass('public.log') is not null then
    alter table public.log rename to training_log;
  end if;
end $$;
