alter table log
add column if not exists source text not null default 'manual',
add column if not exists source_activity_id text,
add column if not exists duration_seconds integer;

alter table log
drop constraint if exists log_source_chk;

alter table log
add constraint log_source_chk
check (source in ('manual', 'strava'));

alter table log
drop constraint if exists log_duration_seconds_chk;

alter table log
add constraint log_duration_seconds_chk
check (duration_seconds is null or duration_seconds >= 0);

alter table log
drop constraint if exists log_source_activity_id_required_chk;

alter table log
add constraint log_source_activity_id_required_chk
check (
  source <> 'strava'
  or source_activity_id is not null
);

create unique index if not exists log_strava_activity_uidx
on log (source_activity_id)
where source = 'strava';

create table if not exists strava_connection (
  id bigint primary key,
  athlete_id bigint not null,
  access_token text not null,
  refresh_token text not null,
  token_expires_at timestamptz not null,
  scope text,
  last_sync_at timestamptz,
  last_sync_status text,
  last_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table strava_connection enable row level security;
