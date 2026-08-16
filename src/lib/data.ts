import { explainSupabaseError, getSupabase } from "./supabase";

export const BUCKET_CHAT_UPLOADS = "chat-uploads";
export const BUCKET_MEMORIES = "memories";

export type Replica = {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  avatar_url: string | null;
  source_filename: string | null;
  source_file_path: string | null;
  status: string;
  message_count: number;
  created_at: string;
  updated_at: string;
};

export type ProcessingJob = {
  id: string;
  replica_id: string | null;
  source_file_id: string | null;
  job_type: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  total_items: number;
  processed_items: number;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export type SourceFile = {
  id: string;
  replica_id: string | null;
  bucket_name: string;
  storage_path: string;
  original_filename: string;
  mime_type: string | null;
  file_size: number | null;
  status: string;
  error_message: string | null;
  created_at: string;
  processed_at: string | null;
};

export type MemoryItem = {
  id: string;
  replica_id: string | null;
  bucket_name: string | null;
  storage_path: string | null;
  title: string | null;
  description: string | null;
  media_type: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type ChatSession = {
  id: string;
  replica_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
};

export type ChatMessage = {
  id: string;
  session_id: string;
  sender_role: "user" | "replica";
  message_text: string | null;
  media_path: string | null;
  media_type: string | null;
  reply_to_message_id: string | null;
  generated_response_id: string | null;
  created_at: string;
};

export type Conversation = {
  id: string;
  replica_id: string;
  title: string | null;
  source_platform: string | null;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
};

export type Participant = {
  id: string;
  replica_id: string;
  display_name: string;
  role: string;
  original_identifier: string | null;
  message_count: number;
};

async function run<T>(
  operation: () => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T> {
  const { data, error } = await operation();
  if (error) {
    console.error("[supabase]", error);
    throw new Error(explainSupabaseError(error));
  }
  return data as T;
}

/* ------------------------------------------------------------------ replicas */
export async function listReplicas(): Promise<Replica[]> {
  const supabase = await getSupabase();
  return run<Replica[]>(() =>
    supabase.from("replicas").select("*").order("created_at", { ascending: false }),
  );
}

export async function getReplica(id: string): Promise<Replica | null> {
  const supabase = await getSupabase();
  return run<Replica | null>(() => supabase.from("replicas").select("*").eq("id", id).maybeSingle());
}

export async function createReplica(
  ownerId: string,
  input: { name: string; description?: string },
): Promise<Replica> {
  const supabase = await getSupabase();
  return run<Replica>(() =>
    supabase
      .from("replicas")
      .insert({ owner_id: ownerId, name: input.name, description: input.description ?? null })
      .select("*")
      .single(),
  );
}

export async function updateReplica(id: string, patch: Partial<Replica>): Promise<Replica> {
  const supabase = await getSupabase();
  return run<Replica>(() =>
    supabase.from("replicas").update(patch).eq("id", id).select("*").single(),
  );
}

/** Cascades cover child rows; storage objects are removed explicitly. */
export async function deleteReplica(ownerId: string, id: string): Promise<void> {
  const supabase = await getSupabase();
  const files = await run<{ bucket_name: string; storage_path: string }[]>(() =>
    supabase.from("source_files").select("bucket_name, storage_path").eq("replica_id", id),
  );
  const memories = await run<{ bucket_name: string | null; storage_path: string | null }[]>(() =>
    supabase.from("memory_items").select("bucket_name, storage_path").eq("replica_id", id),
  );
  const byBucket = new Map<string, string[]>();
  for (const row of [...files, ...memories]) {
    if (!row.bucket_name || !row.storage_path) continue;
    if (!row.storage_path.startsWith(`${ownerId}/`)) continue;
    byBucket.set(row.bucket_name, [...(byBucket.get(row.bucket_name) ?? []), row.storage_path]);
  }
  for (const [bucket, paths] of byBucket) {
    const { error } = await supabase.storage.from(bucket).remove(paths);
    if (error) console.warn("[storage cleanup]", bucket, error.message);
  }
  await run(() => supabase.from("replicas").delete().eq("id", id).select("id"));
}

/* --------------------------------------------------------------------- files */
export async function listSourceFiles(replicaId?: string): Promise<SourceFile[]> {
  const supabase = await getSupabase();
  let query = supabase.from("source_files").select("*").order("created_at", { ascending: false });
  if (replicaId) query = query.eq("replica_id", replicaId);
  return run<SourceFile[]>(() => query);
}

export async function listJobs(replicaId?: string): Promise<ProcessingJob[]> {
  const supabase = await getSupabase();
  let query = supabase.from("processing_jobs").select("*").order("created_at", { ascending: false });
  if (replicaId) query = query.eq("replica_id", replicaId);
  return run<ProcessingJob[]>(() => query);
}

/* ------------------------------------------------------------------ memories */
export async function listMemories(replicaId?: string): Promise<MemoryItem[]> {
  const supabase = await getSupabase();
  let query = supabase.from("memory_items").select("*").order("created_at", { ascending: false });
  if (replicaId) query = query.eq("replica_id", replicaId);
  return run<MemoryItem[]>(() => query);
}

export async function createMemory(
  ownerId: string,
  input: Partial<MemoryItem> & { replica_id?: string | null },
): Promise<MemoryItem> {
  const supabase = await getSupabase();
  return run<MemoryItem>(() =>
    supabase
      .from("memory_items")
      .insert({ ...input, owner_id: ownerId })
      .select("*")
      .single(),
  );
}

export async function updateMemory(id: string, patch: Partial<MemoryItem>): Promise<MemoryItem> {
  const supabase = await getSupabase();
  return run<MemoryItem>(() =>
    supabase.from("memory_items").update(patch).eq("id", id).select("*").single(),
  );
}

export async function deleteMemory(memory: MemoryItem): Promise<void> {
  const supabase = await getSupabase();
  if (memory.bucket_name && memory.storage_path) {
    const { error } = await supabase.storage.from(memory.bucket_name).remove([memory.storage_path]);
    if (error) console.warn("[storage cleanup]", error.message);
  }
  await run(() => supabase.from("memory_items").delete().eq("id", memory.id).select("id"));
}

export async function signedUrl(bucket: string, path: string, seconds = 3600): Promise<string | null> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, seconds);
  if (error) {
    console.warn("[storage signed url]", error.message);
    return null;
  }
  return data?.signedUrl ?? null;
}

/* ------------------------------------------------------- conversations & msgs */
export async function listConversations(replicaId?: string, search?: string): Promise<Conversation[]> {
  const supabase = await getSupabase();
  let query = supabase
    .from("conversations")
    .select("*")
    .order("started_at", { ascending: false, nullsFirst: false })
    .limit(200);
  if (replicaId) query = query.eq("replica_id", replicaId);
  if (search) query = query.ilike("title", `%${search}%`);
  return run<Conversation[]>(() => query);
}

export async function listConversationMessages(conversationId: string) {
  const supabase = await getSupabase();
  return run<
    {
      id: string;
      sender_name: string | null;
      sender_role: string | null;
      message_text: string | null;
      message_type: string | null;
      sent_at: string | null;
    }[]
  >(() =>
    supabase
      .from("messages")
      .select("id, sender_name, sender_role, message_text, message_type, sent_at")
      .eq("conversation_id", conversationId)
      .order("sent_at", { ascending: true, nullsFirst: true })
      .limit(2000),
  );
}

export async function searchMessages(query: string, replicaId?: string) {
  const supabase = await getSupabase();
  let request = supabase
    .from("messages")
    .select("id, replica_id, conversation_id, sender_name, message_text, sent_at")
    .ilike("message_text", `%${query}%`)
    .limit(60);
  if (replicaId) request = request.eq("replica_id", replicaId);
  return run<
    {
      id: string;
      replica_id: string;
      conversation_id: string | null;
      sender_name: string | null;
      message_text: string | null;
      sent_at: string | null;
    }[]
  >(() => request);
}

export async function listParticipants(replicaId: string): Promise<Participant[]> {
  const supabase = await getSupabase();
  return run<Participant[]>(() =>
    supabase
      .from("replica_participants")
      .select("*")
      .eq("replica_id", replicaId)
      .order("message_count", { ascending: false }),
  );
}

export async function setParticipantRole(id: string, role: string) {
  const supabase = await getSupabase();
  return run(() => supabase.from("replica_participants").update({ role }).eq("id", id).select("id"));
}

export async function getStyleProfile(replicaId: string) {
  const supabase = await getSupabase();
  return run<Record<string, unknown> | null>(() =>
    supabase.from("replica_style_profiles").select("*").eq("replica_id", replicaId).maybeSingle(),
  );
}

export async function saveCustomInstructions(replicaId: string, instructions: string) {
  const supabase = await getSupabase();
  return run(() =>
    supabase
      .from("replica_style_profiles")
      .update({ custom_instructions: instructions })
      .eq("replica_id", replicaId)
      .select("replica_id"),
  );
}

/* -------------------------------------------------------------- chat sessions */
export async function listSessions(): Promise<ChatSession[]> {
  const supabase = await getSupabase();
  return run<ChatSession[]>(() =>
    supabase.from("chat_sessions").select("*").order("updated_at", { ascending: false }),
  );
}

export async function createSession(
  ownerId: string,
  replicaId: string,
  title: string,
): Promise<ChatSession> {
  const supabase = await getSupabase();
  return run<ChatSession>(() =>
    supabase
      .from("chat_sessions")
      .insert({ owner_id: ownerId, replica_id: replicaId, title })
      .select("*")
      .single(),
  );
}

export async function renameSession(id: string, title: string) {
  const supabase = await getSupabase();
  return run(() => supabase.from("chat_sessions").update({ title }).eq("id", id).select("id"));
}

export async function deleteSession(id: string) {
  const supabase = await getSupabase();
  return run(() => supabase.from("chat_sessions").delete().eq("id", id).select("id"));
}

export async function listSessionMessages(sessionId: string): Promise<ChatMessage[]> {
  const supabase = await getSupabase();
  return run<ChatMessage[]>(() =>
    supabase
      .from("chat_session_messages")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true }),
  );
}

export async function insertSessionMessage(
  ownerId: string,
  input: {
    session_id: string;
    sender_role: "user" | "replica";
    message_text?: string | null;
    media_path?: string | null;
    media_type?: string | null;
    reply_to_message_id?: string | null;
    generated_response_id?: string | null;
  },
): Promise<ChatMessage> {
  const supabase = await getSupabase();
  const message = await run<ChatMessage>(() =>
    supabase
      .from("chat_session_messages")
      .insert({ ...input, owner_id: ownerId })
      .select("*")
      .single(),
  );
  await supabase
    .from("chat_sessions")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", input.session_id);
  return message;
}

export async function getProfile(userId: string) {
  const supabase = await getSupabase();
  return run<{
    user_id: string;
    display_name: string | null;
    email: string | null;
    avatar_url: string | null;
    created_at: string;
  } | null>(() => supabase.from("profiles").select("*").eq("user_id", userId).maybeSingle());
}

export async function updateProfileRow(
  userId: string,
  patch: { display_name?: string; avatar_url?: string | null },
) {
  const supabase = await getSupabase();
  return run(() =>
    supabase.from("profiles").update(patch).eq("user_id", userId).select("user_id"),
  );
}
