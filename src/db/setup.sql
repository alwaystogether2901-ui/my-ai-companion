-- ============================================================================
-- ALWAYS TOGETHER — complete schema, RLS and storage policies
-- Run this ONCE in the Supabase SQL editor of your project.
--
-- Auth model: Firebase is registered as a Third-Party Auth provider, so
--   auth.jwt() ->> 'sub'  ==  the Firebase UID (text)
-- Every ownership check below uses that value. Nothing is public.
-- ============================================================================

create extension if not exists vector;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- Identity helpers
-- ---------------------------------------------------------------------------
create or replace function public.firebase_uid()
returns text
language sql
stable
as $$
  select nullif(coalesce(auth.jwt() ->> 'sub', auth.jwt() ->> 'user_id'), '')
$$;

-- Return signature changed (uid/role -> uid/role/aud/iss/email), so drop first.
drop function if exists public.current_identity();

create or replace function public.current_identity()
returns table (uid text, role text, aud text, iss text, email text)
language sql
stable
as $$
  select
    public.firebase_uid(),
    coalesce(nullif(auth.jwt() ->> 'role', ''), auth.role(), 'anon'),
    auth.jwt() ->> 'aud',
    auth.jwt() ->> 'iss',
    auth.jwt() ->> 'email'
$$;

grant execute on function public.firebase_uid() to authenticated, anon;
grant execute on function public.current_identity() to authenticated, anon;


create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  user_id text primary key,
  display_name text,
  email text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.replicas (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  name text not null,
  description text,
  avatar_url text,
  source_filename text,
  source_file_path text,
  status text not null default 'draft',
  message_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.source_files (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  replica_id uuid references public.replicas(id) on delete cascade,
  bucket_name text not null,
  storage_path text not null,
  original_filename text not null,
  mime_type text,
  file_size bigint,
  content_hash text,
  status text not null default 'uploaded',
  error_message text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create table if not exists public.memory_items (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  replica_id uuid references public.replicas(id) on delete cascade,
  bucket_name text,
  storage_path text,
  title text,
  description text,
  media_type text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.memory_embeddings (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  memory_id uuid references public.memory_items(id) on delete cascade,
  replica_id uuid references public.replicas(id) on delete cascade,
  embedding vector(1536),
  model_name text,
  dimension integer,
  created_at timestamptz not null default now()
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  replica_id uuid references public.replicas(id) on delete cascade,
  title text,
  source_platform text,
  started_at timestamptz,
  ended_at timestamptz,
  message_count integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.replica_participants (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  replica_id uuid references public.replicas(id) on delete cascade,
  display_name text not null,
  role text not null default 'participant',
  original_identifier text,
  message_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique (replica_id, original_identifier)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  replica_id uuid references public.replicas(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  participant_id uuid references public.replica_participants(id) on delete set null,
  sender_role text,
  sender_name text,
  message_text text,
  message_type text default 'text',
  media_path text,
  original_message_id text,
  reply_to_message_id text,
  sent_at timestamptz,
  source_platform text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.replica_style_profiles (
  replica_id uuid primary key references public.replicas(id) on delete cascade,
  owner_id text not null,
  language_profile jsonb not null default '{}'::jsonb,
  humor_profile jsonb not null default '{}'::jsonb,
  emoji_profile jsonb not null default '{}'::jsonb,
  punctuation_profile jsonb not null default '{}'::jsonb,
  vocabulary_profile jsonb not null default '{}'::jsonb,
  response_length_profile jsonb not null default '{}'::jsonb,
  greeting_profile jsonb not null default '{}'::jsonb,
  personality_profile jsonb not null default '{}'::jsonb,
  custom_instructions text,
  analysis_version integer not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  replica_id uuid references public.replicas(id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.generated_responses (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  replica_id uuid references public.replicas(id) on delete cascade,
  user_message text,
  generated_response text,
  retrieval_context jsonb not null default '{}'::jsonb,
  generation_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.chat_session_messages (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  session_id uuid references public.chat_sessions(id) on delete cascade,
  sender_role text not null,
  message_text text,
  media_path text,
  media_type text,
  reply_to_message_id uuid references public.chat_session_messages(id) on delete set null,
  generated_response_id uuid references public.generated_responses(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  replica_id uuid references public.replicas(id) on delete cascade,
  source_file_id uuid references public.source_files(id) on delete cascade,
  job_type text not null default 'import',
  status text not null default 'pending',
  progress integer not null default 0,
  total_items integer not null default 0,
  processed_items integer not null default 0,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Indexes + triggers
-- ---------------------------------------------------------------------------
create index if not exists replicas_owner_idx on public.replicas (owner_id, created_at desc);
create index if not exists source_files_owner_idx on public.source_files (owner_id, created_at desc);
create index if not exists source_files_hash_idx on public.source_files (owner_id, content_hash);
create index if not exists memory_items_owner_idx on public.memory_items (owner_id, created_at desc);
create index if not exists memory_items_replica_idx on public.memory_items (replica_id);
create index if not exists conversations_replica_idx on public.conversations (replica_id, started_at desc);
create index if not exists messages_replica_idx on public.messages (replica_id, sent_at);
create index if not exists messages_conversation_idx on public.messages (conversation_id, sent_at);
create index if not exists messages_text_idx on public.messages using gin (message_text gin_trgm_ops);
create index if not exists participants_replica_idx on public.replica_participants (replica_id);
create index if not exists chat_sessions_owner_idx on public.chat_sessions (owner_id, updated_at desc);
create index if not exists chat_messages_session_idx on public.chat_session_messages (session_id, created_at);
create index if not exists jobs_owner_idx on public.processing_jobs (owner_id, created_at desc);
create index if not exists generated_owner_idx on public.generated_responses (owner_id, created_at desc);

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
drop trigger if exists replicas_touch on public.replicas;
create trigger replicas_touch before update on public.replicas
  for each row execute function public.touch_updated_at();
drop trigger if exists chat_sessions_touch on public.chat_sessions;
create trigger chat_sessions_touch before update on public.chat_sessions
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Grants + one clean owner policy per table
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'replicas','source_files','memory_items','memory_embeddings','conversations',
    'messages','replica_participants','replica_style_profiles','chat_sessions',
    'chat_session_messages','generated_responses','processing_jobs'
  ]
  loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_all', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (owner_id = public.firebase_uid()) with check (owner_id = public.firebase_uid())',
      t || '_owner_all', t
    );
  end loop;
end $$;

grant select, insert, update, delete on public.profiles to authenticated;
grant all on public.profiles to service_role;
alter table public.profiles enable row level security;
drop policy if exists profiles_owner_all on public.profiles;
create policy profiles_owner_all on public.profiles
  for all to authenticated
  using (user_id = public.firebase_uid())
  with check (user_id = public.firebase_uid());

-- ---------------------------------------------------------------------------
-- Memory search (runs as the caller; RLS still applies)
-- ---------------------------------------------------------------------------
create or replace function public.search_memories(
  p_replica_id uuid,
  p_query text,
  p_limit integer default 8
)
returns table (id uuid, title text, description text, media_type text, storage_path text)
language sql
stable
as $$
  select m.id, m.title, m.description, m.media_type, m.storage_path
  from public.memory_items m
  where m.replica_id = p_replica_id
    and m.owner_id = public.firebase_uid()
    and (
      p_query is null or p_query = ''
      or m.description ilike '%' || p_query || '%'
      or m.title ilike '%' || p_query || '%'
    )
  order by m.created_at desc
  limit greatest(1, least(coalesce(p_limit, 8), 50))
$$;

create or replace function public.match_memory_embeddings(
  p_replica_id uuid,
  p_embedding vector(1536),
  p_limit integer default 8
)
returns table (memory_id uuid, title text, description text, similarity double precision)
language sql
stable
as $$
  select m.id, m.title, m.description,
         1 - (e.embedding <=> p_embedding) as similarity
  from public.memory_embeddings e
  join public.memory_items m on m.id = e.memory_id
  where e.replica_id = p_replica_id
    and e.owner_id = public.firebase_uid()
    and e.embedding is not null
  order by e.embedding <=> p_embedding
  limit greatest(1, least(coalesce(p_limit, 8), 50))
$$;

grant execute on function public.search_memories(uuid, text, integer) to authenticated;
grant execute on function public.match_memory_embeddings(uuid, vector, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- STORAGE POLICIES — buckets 'memories' and 'chat-uploads'
-- Path convention: <bucket>/<firebase_uid>/<file>
-- Exactly four policies per bucket. No public access, no WITH CHECK (true).
-- ---------------------------------------------------------------------------
do $$
declare
  b text;
  op text;
  pol text;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and (coalesce(qual, '') ilike '%chat-uploads%' or coalesce(qual, '') ilike '%memories%'
           or coalesce(with_check, '') ilike '%chat-uploads%' or coalesce(with_check, '') ilike '%memories%')
  loop
    execute format('drop policy if exists %I on storage.objects', pol);
  end loop;

  foreach b in array array['memories','chat-uploads']
  loop
    foreach op in array array['select','insert','update','delete']
    loop
      execute format('drop policy if exists %I on storage.objects',
        replace(b, '-', '_') || '_own_' || op);
    end loop;

    execute format($f$
      create policy %I on storage.objects for select to authenticated
      using (bucket_id = %L and (storage.foldername(name))[1] = public.firebase_uid())
    $f$, replace(b, '-', '_') || '_own_select', b);

    execute format($f$
      create policy %I on storage.objects for insert to authenticated
      with check (bucket_id = %L and (storage.foldername(name))[1] = public.firebase_uid())
    $f$, replace(b, '-', '_') || '_own_insert', b);

    execute format($f$
      create policy %I on storage.objects for update to authenticated
      using (bucket_id = %L and (storage.foldername(name))[1] = public.firebase_uid())
      with check (bucket_id = %L and (storage.foldername(name))[1] = public.firebase_uid())
    $f$, replace(b, '-', '_') || '_own_update', b, b);

    execute format($f$
      create policy %I on storage.objects for delete to authenticated
      using (bucket_id = %L and (storage.foldername(name))[1] = public.firebase_uid())
    $f$, replace(b, '-', '_') || '_own_delete', b);
  end loop;
end $$;
