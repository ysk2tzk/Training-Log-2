create table if not exists public.suunto_connection (
  id bigint primary key,
  access_token text not null,
  refresh_token text,
  token_type text,
  expires_at timestamptz,
  scope text,
  user_name text,
  connected_at timestamptz,
  source text
);
