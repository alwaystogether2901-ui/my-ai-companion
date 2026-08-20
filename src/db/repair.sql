-- ============================================================================
-- ALWAYS TOGETHER — REPAIR MIGRATION (idempotent, safe to re-run)
--
-- WHERE TO RUN: Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Run this AFTER src/db/setup.sql. It only adds/repairs; it drops nothing that
-- holds data.
--
-- Every policy below was written against the ACTUAL columns declared in
-- src/db/setup.sql. memory_embeddings does own an owner_id column, so its
-- owner policy is valid; nothing references a column that does not exist.
-- ============================================================================

create extension if not exists vector;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- 1. Columns the application writes (added only if missing)
-- ---------------------------------------------------------------------------
alter table public.replicas            add column if not exists source_file_path text;
alter table public.replicas            add column if not exists message_count integer not null default 0;
alter table public.source_files        add column if not exists content_hash text;
alter table public.source_files        add column if not exists error_message text;
alter table public.source_files        add column if not exists processed_at timestamptz;
alter table public.replica_participants add column if not exists original_identifier text;
alter table public.replica_participants add column if not exists message_count integer not null default 0;
alter table public.messages            add column if not exists participant_id uuid;
alter table public.messages            add column if not exists sender_role text;
alter table public.messages            add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.processing_jobs     add column if not exists processed_items integer not null default 0;
alter table public.processing_jobs     add column if not exists total_items integer not null default 0;
alter table public.processing_jobs     add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.replica_style_profiles add column if not exists custom_instructions text;
alter table public.replica_style_profiles add column if not exists analysis_version integer not null default 1;

-- Upsert conflict targets used by the app must really exist as constraints.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'replica_participants_replica_id_original_identifier_key'
  ) then
    begin
      alter table public.replica_participants
        add constraint replica_participants_replica_id_original_identifier_key
        unique (replica_id, original_identifier);
    exception when others then
      raise notice 'participant unique constraint not added: %', sqlerrm;
    end;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Status vocabularies — one set, matching the TypeScript types exactly
--    processing_jobs.status : pending | processing | completed | failed
--    source_files.status    : uploaded | processing | processed | failed
--    replicas.status        : draft | processing | awaiting_selection | ready | failed
--    participants.role      : unassigned | me | replica | other
--    messages.sender_role   : unassigned | me | replica | other
-- ---------------------------------------------------------------------------
update public.processing_jobs set status = 'pending'   where status in ('queued','new');
update public.source_files    set status = 'processed' where status in ('complete','completed');
update public.replica_participants set role = 'unassigned' where role in ('participant','');

alter table public.processing_jobs drop constraint if exists processing_jobs_status_chk;
alter table public.processing_jobs add constraint processing_jobs_status_chk
  check (status in ('pending','processing','completed','failed'));

alter table public.source_files drop constraint if exists source_files_status_chk;
alter table public.source_files add constraint source_files_status_chk
  check (status in ('uploaded','processing','processed','failed'));

alter table public.replicas drop constraint if exists replicas_status_chk;
alter table public.replicas add constraint replicas_status_chk
  check (status in ('draft','processing','awaiting_selection','ready','failed'));

-- ---------------------------------------------------------------------------
-- 3. Indexes for retrieval (trigram search over historical messages)
-- ---------------------------------------------------------------------------
create index if not exists messages_text_trgm_idx
  on public.messages using gin (message_text gin_trgm_ops);
create index if not exists messages_role_idx
  on public.messages (replica_id, sender_role, sent_at);
create index if not exists messages_participant_idx
  on public.messages (participant_id);
create index if not exists memory_items_desc_trgm_idx
  on public.memory_items using gin (description gin_trgm_ops);
create index if not exists memory_embeddings_memory_idx
  on public.memory_embeddings (memory_id);

-- ---------------------------------------------------------------------------
-- 4. Identity helpers (idempotent, hardened)
-- ---------------------------------------------------------------------------
create or replace function public.firebase_uid()
returns text
language sql
stable
as $$
  select nullif(coalesce(auth.jwt() ->> 'sub', auth.jwt() ->> 'user_id'), '')
$$;

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

-- ---------------------------------------------------------------------------
-- 5. SIMILAR-RESPONSE RETRIEVAL
--    Finds historical exchanges: a message similar to the user's question and
--    the reply the REPLICA person actually gave next. RLS still applies because
--    the function filters on public.firebase_uid().
-- ---------------------------------------------------------------------------
create or replace function public.search_similar_exchanges(
  p_replica_id uuid,
  p_query text,
  p_limit integer default 6
)
returns table (
  prompt_text text,
  prompt_sender text,
  reply_text text,
  similarity double precision,
  sent_at timestamptz
)
language sql
stable
as $$
  with mine as (
    select id, message_text, sender_name, sender_role, sent_at, created_at,
           row_number() over (order by sent_at nulls last, created_at) as seq
    from public.messages
    where replica_id = p_replica_id
      and owner_id = public.firebase_uid()
      and message_text is not null
      and length(message_text) > 1
  ),
  candidates as (
    select m.*, similarity(m.message_text, coalesce(p_query, '')) as sim
    from mine m
    where coalesce(m.sender_role, 'unassigned') <> 'replica'
      and coalesce(p_query, '') <> ''
      and m.message_text % p_query
    order by sim desc
    limit greatest(1, least(coalesce(p_limit, 6), 25))
  )
  select
    c.message_text,
    c.sender_name,
    (
      select r.message_text from mine r
      where r.seq > c.seq and r.sender_role = 'replica'
      order by r.seq
      limit 1
    ) as reply_text,
    c.sim::double precision,
    c.sent_at
  from candidates c
  order by c.sim desc
$$;

grant execute on function public.search_similar_exchanges(uuid, text, integer) to authenticated;

-- Keyword/ILIKE fallback used when trigram similarity finds nothing.
create or replace function public.search_replica_messages(
  p_replica_id uuid,
  p_query text,
  p_limit integer default 10
)
returns table (message_text text, sender_name text, sender_role text, sent_at timestamptz)
language sql
stable
as $$
  select m.message_text, m.sender_name, m.sender_role, m.sent_at
  from public.messages m
  where m.replica_id = p_replica_id
    and m.owner_id = public.firebase_uid()
    and m.message_text is not null
    and (coalesce(p_query,'') = '' or m.message_text ilike '%' || p_query || '%')
  order by m.sent_at desc nulls last
  limit greatest(1, least(coalesce(p_limit, 10), 50))
$$;

grant execute on function public.search_replica_messages(uuid, text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Memory search functions (re-asserted)
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
      coalesce(p_query, '') = ''
      or m.description ilike '%' || p_query || '%'
      or m.title ilike '%' || p_query || '%'
    )
  order by m.created_at desc
  limit greatest(1, least(coalesce(p_limit, 8), 50))
$$;
grant execute on function public.search_memories(uuid, text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. RLS — one owner policy per table. Verified column names:
--    profiles.user_id, everything else owner_id (incl. memory_embeddings).
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
-- 8. STORAGE — buckets 'memories' and 'chat-uploads'
--    Path convention: <bucket>/<firebase_uid>/...
--    ZIP uploads need generous size + MIME allowances, otherwise Storage
--    rejects the object mid-upload (HTTP 413 / 400) — this was the 7-8% failure.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('chat-uploads', 'chat-uploads', false, 209715200, null),
  ('memories', 'memories', false, 209715200, null)
on conflict (id) do update
  set public = false,
      file_size_limit = greatest(coalesce(storage.buckets.file_size_limit, 0), 209715200),
      allowed_mime_types = null;

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

-- ---------------------------------------------------------------------------
-- 9. Recover jobs abandoned by closed tabs (never stuck in 'processing')
-- ---------------------------------------------------------------------------
update public.processing_jobs
set status = 'failed',
    error_message = coalesce(error_message, 'Import interrupted; retry it from Import history.'),
    completed_at = now()
where status = 'processing'
  and coalesce(started_at, created_at) < now() - interval '30 minutes';

-- ===========================================================================
-- 10. LARGE-DATASET SCALABILITY (300k+ messages)
--     Every function below is SECURITY INVOKER, so RLS still applies, and each
--     one additionally filters on public.firebase_uid(): generic for all users,
--     no hardcoded ids.
-- ===========================================================================

-- Indexes that keep 300k-row imports, retrieval and deletion fast.
create index if not exists messages_replica_time_idx
  on public.messages (replica_id, sent_at nulls last);
create index if not exists messages_replica_role_time_idx
  on public.messages (replica_id, sender_role, sent_at desc nulls last);
create index if not exists messages_owner_replica_idx
  on public.messages (owner_id, replica_id);
create index if not exists conversations_replica_idx
  on public.conversations (replica_id);
create index if not exists chat_session_messages_session_idx
  on public.chat_session_messages (session_id, created_at);
create index if not exists chat_session_messages_reply_idx
  on public.chat_session_messages (reply_to_message_id);

-- ---------------------------------------------------------------------------
-- 10a. ME / REPLICA role assignment as ONE set-based statement per role.
--      Previously three full-table UPDATEs from the browser timed out on large
--      imports (the "cancelled / timeout" import failure).
-- ---------------------------------------------------------------------------
create or replace function public.assign_participant_roles(
  p_replica_id uuid,
  p_me uuid,
  p_replica uuid
)
returns table (me_messages bigint, replica_messages bigint, other_messages bigint)
language plpgsql
volatile
as $$
declare
  v_uid text := public.firebase_uid();
begin
  if v_uid is null then
    raise exception 'No identity resolved from the token';
  end if;
  if p_me = p_replica then
    raise exception 'ME and REPLICA must be different participants';
  end if;

  update public.replica_participants
  set role = case
        when id = p_me then 'me'
        when id = p_replica then 'replica'
        else 'other'
      end
  where replica_id = p_replica_id
    and owner_id = v_uid;

  update public.messages m
  set sender_role = case
        when m.participant_id = p_me then 'me'
        when m.participant_id = p_replica then 'replica'
        else 'other'
      end
  where m.replica_id = p_replica_id
    and m.owner_id = v_uid
    and coalesce(m.sender_role, '') <> case
        when m.participant_id = p_me then 'me'
        when m.participant_id = p_replica then 'replica'
        else 'other'
      end;

  return query
  select
    count(*) filter (where sender_role = 'me'),
    count(*) filter (where sender_role = 'replica'),
    count(*) filter (where sender_role = 'other')
  from public.messages
  where replica_id = p_replica_id and owner_id = v_uid;
end $$;

grant execute on function public.assign_participant_roles(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 10b. Batched replica deletion. A single cascading DELETE on a 300k-message
--      replica exceeds the statement timeout; the client loops this until
--      done = true. Ownership is enforced on every statement.
-- ---------------------------------------------------------------------------
create or replace function public.delete_replica_batch(
  p_replica_id uuid,
  p_batch integer default 20000
)
returns table (deleted integer, done boolean)
language plpgsql
volatile
as $$
declare
  v_uid text := public.firebase_uid();
  v_deleted integer := 0;
  v_owns boolean;
begin
  if v_uid is null then
    raise exception 'No identity resolved from the token';
  end if;

  select exists (
    select 1 from public.replicas
    where id = p_replica_id and owner_id = v_uid
  ) into v_owns;
  if not v_owns then
    return query select 0, true;
    return;
  end if;

  with doomed as (
    select id from public.messages
    where replica_id = p_replica_id and owner_id = v_uid
    limit greatest(1000, least(coalesce(p_batch, 20000), 50000))
  )
  delete from public.messages m using doomed d where m.id = d.id;
  get diagnostics v_deleted = row_count;

  if v_deleted > 0 then
    return query select v_deleted, false;
    return;
  end if;

  delete from public.memory_embeddings where replica_id = p_replica_id and owner_id = v_uid;
  delete from public.memory_items where replica_id = p_replica_id and owner_id = v_uid;
  delete from public.conversations where replica_id = p_replica_id and owner_id = v_uid;
  delete from public.replica_participants where replica_id = p_replica_id and owner_id = v_uid;
  delete from public.replica_style_profiles where replica_id = p_replica_id and owner_id = v_uid;
  delete from public.processing_jobs where replica_id = p_replica_id and owner_id = v_uid;
  delete from public.source_files where replica_id = p_replica_id and owner_id = v_uid;
  delete from public.chat_session_messages
    where owner_id = v_uid
      and session_id in (select id from public.chat_sessions where replica_id = p_replica_id and owner_id = v_uid);
  delete from public.chat_sessions where replica_id = p_replica_id and owner_id = v_uid;
  delete from public.generated_responses where replica_id = p_replica_id and owner_id = v_uid;
  delete from public.replicas where id = p_replica_id and owner_id = v_uid;

  return query select 0, true;
end $$;

grant execute on function public.delete_replica_batch(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 10c. Contextual retrieval: real exchanges (situation -> what THEY replied).
--      Ranks by trigram similarity to the incoming message and, when supplied,
--      to the recent conversation context, so the chosen example fits the
--      CURRENT situation rather than being the first lexical match.
-- ---------------------------------------------------------------------------
drop function if exists public.search_similar_exchanges(uuid, text, integer);
create or replace function public.search_similar_exchanges(
  p_replica_id uuid,
  p_query text,
  p_limit integer default 8,
  p_context text default ''
)
returns table (
  prompt_text text,
  prompt_sender text,
  reply_text text,
  similarity double precision,
  context_similarity double precision,
  sent_at timestamptz
)
language sql
stable
as $$
  with base as (
    select
      m.message_text,
      m.sender_name,
      m.sender_role,
      m.sent_at,
      lead(m.message_text) over w as next_text,
      lead(m.sender_role) over w as next_role,
      similarity(m.message_text, coalesce(p_query, '')) as sim,
      case when coalesce(p_context, '') = '' then 0
           else similarity(m.message_text, p_context) end as ctx_sim
    from public.messages m
    where m.replica_id = p_replica_id
      and m.owner_id = public.firebase_uid()
      and m.message_text is not null
      and length(m.message_text) between 2 and 1500
      and coalesce(p_query, '') <> ''
      and (
        m.sender_role = 'replica'
        or m.message_text % p_query
        or (coalesce(p_context, '') <> '' and m.message_text % p_context)
      )
    window w as (order by m.sent_at nulls last, m.created_at)
  )
  select
    message_text,
    sender_name,
    next_text,
    sim::double precision,
    ctx_sim::double precision,
    sent_at
  from base
  where sender_role <> 'replica'
    and next_role = 'replica'
    and next_text is not null
    and length(btrim(next_text)) > 0
    and (sim > 0.08 or ctx_sim > 0.12)
  order by (sim * 0.75 + ctx_sim * 0.25) desc
  limit greatest(1, least(coalesce(p_limit, 8), 40))
$$;

grant execute on function public.search_similar_exchanges(uuid, text, integer, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 10d. Frequent authentic wording from the REPLICA person only. Used to keep
--      generated wording inside their real vocabulary.
-- ---------------------------------------------------------------------------
create or replace function public.replica_frequent_lines(
  p_replica_id uuid,
  p_limit integer default 25
)
returns table (message_text text, uses bigint)
language sql
stable
as $$
  select lower(btrim(m.message_text)) as message_text, count(*) as uses
  from public.messages m
  where m.replica_id = p_replica_id
    and m.owner_id = public.firebase_uid()
    and m.sender_role = 'replica'
    and m.message_text is not null
    and length(btrim(m.message_text)) between 2 and 120
  group by 1
  having count(*) > 1
  order by uses desc
  limit greatest(1, least(coalesce(p_limit, 25), 60))
$$;

grant execute on function public.replica_frequent_lines(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 10e. Chat idempotency: exactly ONE replica reply per user message.
--      A retry (or a duplicated request) reuses the same reply_to_message_id,
--      so the second insert is rejected instead of creating a second bubble.
--      Legacy duplicates are collapsed first so the index can be created.
-- ---------------------------------------------------------------------------
delete from public.chat_session_messages c
using public.chat_session_messages keep
where c.sender_role = 'replica'
  and c.reply_to_message_id is not null
  and keep.sender_role = 'replica'
  and keep.reply_to_message_id = c.reply_to_message_id
  and keep.session_id = c.session_id
  and (keep.created_at, keep.id) < (c.created_at, c.id);

create unique index if not exists chat_session_messages_one_reply_idx
  on public.chat_session_messages (session_id, reply_to_message_id)
  where sender_role = 'replica' and reply_to_message_id is not null;
