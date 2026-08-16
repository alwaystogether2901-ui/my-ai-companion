import { getSupabase, explainSupabaseError } from "./supabase";
import {
  BUCKET_CHAT_UPLOADS,
  BUCKET_MEMORIES,
  type ProcessingJob,
} from "./data";
import { parseUploadedFile, guessMediaType, type ParsedConversation } from "./parsers";
import { analyzeStyle } from "./style-analysis";

export type ImportProgress = { step: string; progress: number };

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB
export const ALLOWED_IMPORT_EXTENSIONS = [".zip", ".txt", ".json", ".csv", ".md", ".log"];
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

export function sanitizeFileName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(-120);
}

export function validateImportFile(file: File): string | null {
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (!ALLOWED_IMPORT_EXTENSIONS.includes(ext)) {
    return `"${ext || "unknown"}" is not an importable conversation export. Use ${ALLOWED_IMPORT_EXTENSIONS.join(", ")}.`;
  }
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_UPLOAD_BYTES) return "That file is larger than the 200 MB upload limit.";
  return null;
}

export async function hashFile(file: File): Promise<string> {
  const buffer = await file.slice(0, 4 * 1024 * 1024).arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return `${file.size}-${Array.from(new Uint8Array(digest))
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Compress large images client-side before upload. */
export async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.size < 800 * 1024 || file.type === "image/gif") {
    return file;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const maxDimension = 1920;
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.82),
    );
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" });
  } catch {
    return file;
  }
}

async function updateJob(jobId: string, patch: Partial<ProcessingJob>) {
  const supabase = await getSupabase();
  const { error } = await supabase.from("processing_jobs").update(patch).eq("id", jobId);
  if (error) console.warn("[job update]", error.message);
}

export type ImportResult = {
  replicaId: string;
  jobId: string;
  conversations: number;
  messages: number;
  participants: number;
  memories: number;
  duplicate: boolean;
};

/**
 * Full import flow: verify auth (caller does), upload -> source_files -> processing_jobs
 * -> parse -> conversations/messages/participants -> style profile -> memories.
 * Progress is written to processing_jobs so the UI can follow along.
 */
export async function importConversationFile(options: {
  ownerId: string;
  file: File;
  replicaId?: string;
  replicaName?: string;
  onProgress?: (progress: ImportProgress) => void;
}): Promise<ImportResult> {
  const { ownerId, file, onProgress } = options;
  const supabase = await getSupabase();
  const report = (step: string, progress: number) => onProgress?.({ step, progress });

  const validationError = validateImportFile(file);
  if (validationError) throw new Error(validationError);

  // ---- Duplicate protection -------------------------------------------------
  const contentHash = await hashFile(file);
  const { data: existing } = await supabase
    .from("source_files")
    .select("id, replica_id, status")
    .eq("owner_id", ownerId)
    .eq("content_hash", contentHash)
    .limit(1);
  const duplicate = Boolean(existing && existing.length > 0);

  // ---- Replica --------------------------------------------------------------
  report("Preparing replica", 3);
  let replicaId = options.replicaId ?? null;
  if (!replicaId) {
    const { data: replica, error } = await supabase
      .from("replicas")
      .insert({
        owner_id: ownerId,
        name: options.replicaName?.trim() || file.name.replace(/\.[^.]+$/, ""),
        status: "processing",
        source_filename: file.name,
      })
      .select("id")
      .single();
    if (error) throw new Error(explainSupabaseError(error));
    replicaId = replica!.id as string;
  } else {
    await supabase.from("replicas").update({ status: "processing" }).eq("id", replicaId);
  }

  // ---- Storage upload -------------------------------------------------------
  report("Uploading to secure storage", 8);
  const storagePath = `${ownerId}/${Date.now()}-${sanitizeFileName(file.name)}`;
  const { error: uploadError } = await supabase.storage
    .from(BUCKET_CHAT_UPLOADS)
    .upload(storagePath, file, {
      upsert: false,
      contentType: file.type || "application/octet-stream",
    });
  if (uploadError) throw new Error(explainSupabaseError(uploadError));

  // Verify the object really exists before recording it.
  const { data: listed, error: listError } = await supabase.storage
    .from(BUCKET_CHAT_UPLOADS)
    .list(ownerId, { search: storagePath.split("/").pop() ?? "" });
  if (listError) throw new Error(explainSupabaseError(listError));
  if (!listed?.length) throw new Error("Upload completed but the stored object could not be verified.");

  const { data: sourceFile, error: sourceError } = await supabase
    .from("source_files")
    .insert({
      owner_id: ownerId,
      replica_id: replicaId,
      bucket_name: BUCKET_CHAT_UPLOADS,
      storage_path: storagePath,
      original_filename: file.name,
      mime_type: file.type || null,
      file_size: file.size,
      content_hash: contentHash,
      status: "processing",
    })
    .select("id")
    .single();
  if (sourceError) throw new Error(explainSupabaseError(sourceError));

  const { data: job, error: jobError } = await supabase
    .from("processing_jobs")
    .insert({
      owner_id: ownerId,
      replica_id: replicaId,
      source_file_id: sourceFile!.id,
      job_type: "conversation_import",
      status: "processing",
      progress: 10,
      started_at: new Date().toISOString(),
      metadata: { filename: file.name, duplicate },
    })
    .select("id")
    .single();
  if (jobError) throw new Error(explainSupabaseError(jobError));
  const jobId = job!.id as string;

  try {
    // ---- Parse --------------------------------------------------------------
    report("Detecting format", 14);
    const parsed = await parseUploadedFile(file, (message, ratio) => {
      report(message, 14 + ratio * 20);
    });
    const conversations: ParsedConversation[] = parsed.conversations;
    const allMessages = conversations.flatMap((c) => c.messages);
    await updateJob(jobId, {
      progress: 35,
      total_items: allMessages.length,
      metadata: { filename: file.name, format: parsed.detectedFormat, duplicate },
    });

    // ---- Participants -------------------------------------------------------
    report("Detecting participants", 38);
    const counts = new Map<string, number>();
    for (const message of allMessages) {
      counts.set(message.senderName, (counts.get(message.senderName) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const participantRows = sorted.map(([name, count], index) => ({
      owner_id: ownerId,
      replica_id: replicaId,
      display_name: name,
      original_identifier: name,
      role: index === 0 ? "replica" : "other",
      message_count: count,
    }));
    const { data: participants, error: participantError } = await supabase
      .from("replica_participants")
      .upsert(participantRows, { onConflict: "replica_id,original_identifier" })
      .select("id, display_name, role");
    if (participantError) throw new Error(explainSupabaseError(participantError));
    const participantByName = new Map(
      (participants ?? []).map((p) => [p.display_name as string, p.id as string]),
    );
    const replicaParticipant = (participants ?? []).find((p) => p.role === "replica");

    // ---- Conversations + messages ------------------------------------------
    let insertedMessages = 0;
    for (const [index, conversation] of conversations.entries()) {
      const times = conversation.messages
        .map((m) => m.sentAt)
        .filter((value): value is string => Boolean(value))
        .sort();
      const { data: conversationRow, error: conversationError } = await supabase
        .from("conversations")
        .insert({
          owner_id: ownerId,
          replica_id: replicaId,
          title: conversation.title,
          source_platform: conversation.sourcePlatform,
          started_at: times[0] ?? null,
          ended_at: times[times.length - 1] ?? null,
          message_count: conversation.messages.length,
        })
        .select("id")
        .single();
      if (conversationError) throw new Error(explainSupabaseError(conversationError));

      const chunkSize = 400;
      for (let offset = 0; offset < conversation.messages.length; offset += chunkSize) {
        const chunk = conversation.messages.slice(offset, offset + chunkSize).map((message) => ({
          owner_id: ownerId,
          replica_id: replicaId,
          conversation_id: conversationRow!.id,
          participant_id: participantByName.get(message.senderName) ?? null,
          sender_role:
            replicaParticipant && message.senderName === replicaParticipant.display_name
              ? "replica"
              : "other",
          sender_name: message.senderName,
          message_text: message.text,
          message_type: message.messageType,
          media_path: null,
          original_message_id: message.originalMessageId ?? null,
          reply_to_message_id: message.replyToMessageId ?? null,
          sent_at: message.sentAt,
          source_platform: conversation.sourcePlatform,
          metadata: message.mediaHint ? { media_hint: message.mediaHint } : {},
        }));
        const { error: messageError } = await supabase.from("messages").insert(chunk);
        if (messageError) throw new Error(explainSupabaseError(messageError));
        insertedMessages += chunk.length;
        const progress =
          40 + Math.round((insertedMessages / Math.max(allMessages.length, 1)) * 35);
        report(`Importing messages (${insertedMessages}/${allMessages.length})`, progress);
        await updateJob(jobId, { progress, processed_items: insertedMessages });
      }
      report(
        `Imported conversation ${index + 1}/${conversations.length}`,
        Math.min(75, 40 + Math.round(((index + 1) / conversations.length) * 35)),
      );
    }

    // ---- Style analysis -----------------------------------------------------
    report("Analyzing communication style", 80);
    const replicaMessages = replicaParticipant
      ? allMessages.filter((m) => m.senderName === replicaParticipant.display_name)
      : allMessages;
    const style = analyzeStyle(replicaMessages.length > 5 ? replicaMessages : allMessages);
    const { error: styleError } = await supabase.from("replica_style_profiles").upsert(
      { replica_id: replicaId, owner_id: ownerId, ...style, analysis_version: 1 },
      { onConflict: "replica_id" },
    );
    if (styleError) throw new Error(explainSupabaseError(styleError));

    // ---- Memories (text highlights + archive media) -------------------------
    report("Building memories", 86);
    const memoryRows = allMessages
      .filter((m) => (m.text ?? "").length > 60)
      .slice(0, 300)
      .map((m) => ({
        owner_id: ownerId,
        replica_id: replicaId,
        title: `${m.senderName} · ${m.sentAt ? new Date(m.sentAt).toLocaleDateString() : "undated"}`,
        description: m.text.slice(0, 2000),
        media_type: "text",
        metadata: { sender: m.senderName, sent_at: m.sentAt, source: file.name },
      }));
    if (memoryRows.length) {
      const { error: memoryError } = await supabase.from("memory_items").insert(memoryRows);
      if (memoryError) throw new Error(explainSupabaseError(memoryError));
    }

    let mediaSaved = 0;
    for (const media of parsed.mediaFiles) {
      if (media.blob.size > MAX_MEDIA_BYTES) continue;
      const path = `${ownerId}/${replicaId}/${Date.now()}-${sanitizeFileName(media.name)}`;
      const { error: mediaError } = await supabase.storage
        .from(BUCKET_MEMORIES)
        .upload(path, media.blob, { upsert: false });
      if (mediaError) {
        console.warn("[media upload]", mediaError.message);
        continue;
      }
      const { error: mediaRowError } = await supabase.from("memory_items").insert({
        owner_id: ownerId,
        replica_id: replicaId,
        bucket_name: BUCKET_MEMORIES,
        storage_path: path,
        title: media.name,
        media_type: guessMediaType(media.name),
        metadata: { source: file.name, size: media.blob.size },
      });
      if (mediaRowError) console.warn("[media row]", mediaRowError.message);
      else mediaSaved += 1;
      report(`Archiving media (${mediaSaved}/${parsed.mediaFiles.length})`, 88);
    }

    // ---- Finalize -----------------------------------------------------------
    report("Finishing up", 96);
    await supabase
      .from("replicas")
      .update({
        status: "ready",
        message_count: insertedMessages,
        source_filename: file.name,
        source_file_path: storagePath,
      })
      .eq("id", replicaId);
    await supabase
      .from("source_files")
      .update({ status: "processed", processed_at: new Date().toISOString() })
      .eq("id", sourceFile!.id);
    await updateJob(jobId, {
      status: "completed",
      progress: 100,
      processed_items: insertedMessages,
      total_items: allMessages.length,
      completed_at: new Date().toISOString(),
    });
    report("Complete", 100);

    return {
      replicaId: replicaId!,
      jobId,
      conversations: conversations.length,
      messages: insertedMessages,
      participants: participantRows.length,
      memories: memoryRows.length + mediaSaved,
      duplicate,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateJob(jobId, {
      status: "failed",
      error_message: message,
      completed_at: new Date().toISOString(),
    });
    await supabase
      .from("source_files")
      .update({ status: "failed", error_message: message })
      .eq("id", sourceFile!.id);
    await supabase.from("replicas").update({ status: "failed" }).eq("id", replicaId);
    throw error instanceof Error ? error : new Error(message);
  }
}

/** Retry a failed import by re-downloading the stored object. */
export async function retryImport(options: {
  ownerId: string;
  sourceFileId: string;
  onProgress?: (progress: ImportProgress) => void;
}): Promise<ImportResult> {
  const supabase = await getSupabase();
  const { data: source, error } = await supabase
    .from("source_files")
    .select("*")
    .eq("id", options.sourceFileId)
    .single();
  if (error) throw new Error(explainSupabaseError(error));
  const { data: blob, error: downloadError } = await supabase.storage
    .from(source!.bucket_name)
    .download(source!.storage_path);
  if (downloadError) throw new Error(explainSupabaseError(downloadError));
  const file = new File([blob!], source!.original_filename, {
    type: source!.mime_type ?? "application/octet-stream",
  });
  return importConversationFile({
    ownerId: options.ownerId,
    file,
    replicaId: source!.replica_id ?? undefined,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
}
