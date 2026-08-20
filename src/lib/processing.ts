import { getSupabase } from "./supabase";
import { AppError, formatError, stageError } from "./errors";
import { uploadWithProgress, verifyStorageObject } from "./storage-upload";
import {
  BUCKET_CHAT_UPLOADS,
  BUCKET_MEMORIES,
  type ProcessingJob,
} from "./data";
import { parseUploadedFile, guessMediaType, type ParsedConversation } from "./parsers";
import { analyzeStyle } from "./style-analysis";

/** Named pipeline stages — the UI shows exactly which one failed. */
export const IMPORT_STAGES = [
  "Preparing",
  "Uploading",
  "Verifying upload",
  "Creating source record",
  "Creating processing job",
  "Parsing",
  "Importing conversations",
  "Importing messages",
  "Analyzing style",
  "Building memories",
  "Finalizing",
  "Complete",
] as const;
export type ImportStage = (typeof IMPORT_STAGES)[number];

export type ImportProgress = { stage: ImportStage; step: string; progress: number };

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB
export const ALLOWED_IMPORT_EXTENSIONS = [".zip", ".txt", ".json", ".csv", ".md", ".log"];
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

export function sanitizeFileName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+/, "")
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
  if (error) console.warn("[job update]", formatError(error));
}

/** ZIP MIME types vary wildly across browsers; normalise so bucket filters match. */
function uploadContentType(file: File): string {
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (ext === ".zip") return "application/zip";
  if (ext === ".json") return "application/json";
  if (ext === ".csv") return "text/csv";
  if ([".txt", ".md", ".log"].includes(ext)) return "text/plain";
  return file.type || "application/octet-stream";
}

export type ImportResult = {
  replicaId: string;
  jobId: string;
  conversations: number;
  messages: number;
  participants: number;
  memories: number;
  duplicate: boolean;
  /** Always true after an import: the user must choose ME and REPLICA. */
  needsParticipantSelection: boolean;
};

/**
 * Full import: upload -> source_files -> processing_jobs -> parse ->
 * conversations/messages/participants -> provisional style -> memories.
 *
 * Participant ROLES ARE NOT GUESSED. Everyone is imported as "unassigned"; the
 * replica stays in status 'awaiting_selection' until the user picks who is ME
 * and who becomes the REPLICA (see finalizeParticipantRoles).
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
  const report = (stage: ImportStage, step: string, progress: number) =>
    onProgress?.({ stage, step, progress: Math.min(100, Math.max(0, progress)) });

  const validationError = validateImportFile(file);
  if (validationError) throw new AppError(validationError, { kind: "validation", stage: "Preparing" });

  // ---- Preparing ------------------------------------------------------------
  report("Preparing", "Checking the file and your replica", 1);
  let contentHash: string;
  let duplicate = false;
  try {
    contentHash = await hashFile(file);
    const { data: existing, error } = await supabase
      .from("source_files")
      .select("id")
      .eq("owner_id", ownerId)
      .eq("content_hash", contentHash)
      .limit(1);
    if (error) throw error;
    duplicate = Boolean(existing && existing.length > 0);
  } catch (error) {
    throw stageError("Preparing", error, "database");
  }

  let replicaId = options.replicaId ?? null;
  try {
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
      if (error) throw error;
      replicaId = replica!.id as string;
    } else {
      const { error } = await supabase
        .from("replicas")
        .update({ status: "processing" })
        .eq("id", replicaId);
      if (error) throw error;
    }
  } catch (error) {
    throw stageError("Preparing", error, "database");
  }

  // ---- Uploading (real byte progress, 4% -> 40%) ----------------------------
  const storagePath = `${ownerId}/${Date.now()}-${sanitizeFileName(file.name)}`;
  report("Uploading", `Uploading ${(file.size / 1024 / 1024).toFixed(1)} MB`, 4);
  await uploadWithProgress({
    bucket: BUCKET_CHAT_UPLOADS,
    path: storagePath,
    body: file,
    contentType: uploadContentType(file),
    upsert: false,
    onProgress: ({ loaded, total, ratio }) => {
      report(
        "Uploading",
        `Uploading ${(loaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`,
        4 + ratio * 36,
      );
    },
  });

  // ---- Verifying upload -----------------------------------------------------
  report("Verifying upload", "Confirming the stored object", 41);
  await verifyStorageObject(BUCKET_CHAT_UPLOADS, storagePath);

  // ---- Creating source record ----------------------------------------------
  report("Creating source record", "Recording the source file", 43);
  let sourceFileId: string;
  try {
    const { data: sourceFile, error } = await supabase
      .from("source_files")
      .insert({
        owner_id: ownerId,
        replica_id: replicaId,
        bucket_name: BUCKET_CHAT_UPLOADS,
        storage_path: storagePath,
        original_filename: file.name,
        mime_type: uploadContentType(file),
        file_size: file.size,
        content_hash: contentHash,
        status: "processing",
      })
      .select("id")
      .single();
    if (error) throw error;
    sourceFileId = sourceFile!.id as string;
  } catch (error) {
    throw stageError(
      "Creating source record",
      error,
      "database",
    );
  }

  // ---- Creating processing job ---------------------------------------------
  report("Creating processing job", "Starting the import job", 45);
  let jobId: string;
  try {
    const { data: job, error } = await supabase
      .from("processing_jobs")
      .insert({
        owner_id: ownerId,
        replica_id: replicaId,
        source_file_id: sourceFileId,
        job_type: "conversation_import",
        status: "processing",
        progress: 45,
        started_at: new Date().toISOString(),
        metadata: { filename: file.name, duplicate },
      })
      .select("id")
      .single();
    if (error) throw error;
    jobId = job!.id as string;
  } catch (error) {
    throw stageError("Creating processing job", error, "database");
  }

  let currentStage: ImportStage = "Parsing";
  try {
    // ---- Parsing ------------------------------------------------------------
    report("Parsing", "Detecting the export format", 46);
    let parsed;
    try {
      parsed = await parseUploadedFile(file, (message, ratio) => {
        report("Parsing", message, 46 + ratio * 9);
      });
    } catch (error) {
      throw stageError("Parsing", error, "parse");
    }
    const conversations: ParsedConversation[] = parsed.conversations;
    const allMessages = conversations.flatMap((c) => c.messages);
    if (allMessages.length === 0) {
      throw new AppError(
        "No messages could be parsed from this export. Supported: WhatsApp .txt, JSON archives, CSV logs, or a ZIP containing them.",
        { kind: "parse", stage: "Parsing" },
      );
    }
    await updateJob(jobId, {
      progress: 55,
      total_items: allMessages.length,
      metadata: { filename: file.name, format: parsed.detectedFormat, duplicate },
    });

    // ---- Importing conversations (participants first) ------------------------
    currentStage = "Importing conversations";
    report("Importing conversations", "Detecting participants", 56);
    const counts = new Map<string, number>();
    for (const message of allMessages) {
      counts.set(message.senderName, (counts.get(message.senderName) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const participantRows = sorted.map(([name, count]) => ({
      owner_id: ownerId,
      replica_id: replicaId,
      display_name: name,
      original_identifier: name,
      role: "unassigned",
      message_count: count,
    }));
    const { data: participants, error: participantError } = await supabase
      .from("replica_participants")
      .upsert(participantRows, { onConflict: "replica_id,original_identifier" })
      .select("id, display_name, role");
    if (participantError) throw stageError("Importing conversations", participantError, "database");
    const participantByName = new Map(
      (participants ?? []).map((p) => [p.display_name as string, p.id as string]),
    );

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
      if (conversationError) throw stageError("Importing conversations", conversationError, "database");

      currentStage = "Importing messages";
      const chunkSize = 400;
      for (let offset = 0; offset < conversation.messages.length; offset += chunkSize) {
        const chunk = conversation.messages.slice(offset, offset + chunkSize).map((message) => ({
          owner_id: ownerId,
          replica_id: replicaId,
          conversation_id: conversationRow!.id,
          participant_id: participantByName.get(message.senderName) ?? null,
          // Roles are assigned only after the user picks ME / REPLICA.
          sender_role: "unassigned",
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
        if (messageError) throw stageError("Importing messages", messageError, "database");
        insertedMessages += chunk.length;
        const progress = 56 + Math.round((insertedMessages / Math.max(allMessages.length, 1)) * 24);
        report(
          "Importing messages",
          `Importing messages (${insertedMessages.toLocaleString()}/${allMessages.length.toLocaleString()})`,
          progress,
        );
        await updateJob(jobId, { progress, processed_items: insertedMessages });
      }
      report(
        "Importing conversations",
        `Imported conversation ${index + 1}/${conversations.length}`,
        Math.min(80, 56 + Math.round(((index + 1) / conversations.length) * 24)),
      );
    }

    // ---- Analyzing style (provisional: recomputed after ME/REPLICA choice) ---
    currentStage = "Analyzing style";
    report("Analyzing style", "Building a provisional style profile", 82);
    const style = analyzeStyle(allMessages);
    const { error: styleError } = await supabase.from("replica_style_profiles").upsert(
      { replica_id: replicaId, owner_id: ownerId, ...style, analysis_version: 1 },
      { onConflict: "replica_id" },
    );
    if (styleError) throw stageError("Analyzing style", styleError, "database");

    // ---- Building memories ---------------------------------------------------
    currentStage = "Building memories";
    report("Building memories", "Extracting memory highlights", 86);
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
      if (memoryError) throw stageError("Building memories", memoryError, "database");
    }

    let mediaSaved = 0;
    for (const media of parsed.mediaFiles) {
      if (media.blob.size > MAX_MEDIA_BYTES) continue;
      const path = `${ownerId}/${replicaId}/${Date.now()}-${sanitizeFileName(media.name)}`;
      try {
        await uploadWithProgress({
          bucket: BUCKET_MEMORIES,
          path,
          body: media.blob,
          contentType: media.blob.type || "application/octet-stream",
        });
      } catch (error) {
        console.warn("[media upload]", formatError(error));
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
      if (mediaRowError) console.warn("[media row]", formatError(mediaRowError));
      else mediaSaved += 1;
      report(
        "Building memories",
        `Archiving media (${mediaSaved}/${parsed.mediaFiles.length})`,
        90,
      );
    }

    // ---- Finalizing ---------------------------------------------------------
    currentStage = "Finalizing";
    report("Finalizing", "Waiting for your participant choice", 96);
    await supabase
      .from("replicas")
      .update({
        status: "awaiting_selection",
        message_count: insertedMessages,
        source_filename: file.name,
        source_file_path: storagePath,
      })
      .eq("id", replicaId);
    await supabase
      .from("source_files")
      .update({ status: "processed", processed_at: new Date().toISOString() })
      .eq("id", sourceFileId);
    await updateJob(jobId, {
      status: "completed",
      progress: 100,
      processed_items: insertedMessages,
      total_items: allMessages.length,
      completed_at: new Date().toISOString(),
    });
    report("Complete", "Import complete — now choose who is who", 100);

    return {
      replicaId: replicaId!,
      jobId,
      conversations: conversations.length,
      messages: insertedMessages,
      participants: participantRows.length,
      memories: memoryRows.length + mediaSaved,
      duplicate,
      needsParticipantSelection: true,
    };
  } catch (error) {
    const wrapped = stageError(currentStage, error);
    const message = formatError(wrapped);
    await updateJob(jobId, {
      status: "failed",
      error_message: message.slice(0, 900),
      completed_at: new Date().toISOString(),
    });
    await supabase
      .from("source_files")
      .update({ status: "failed", error_message: message.slice(0, 900) })
      .eq("id", sourceFileId);
    await supabase.from("replicas").update({ status: "failed" }).eq("id", replicaId);
    throw wrapped;
  }
}

export type ParticipantChoice = {
  ownerId: string;
  replicaId: string;
  /** replica_participants.id of the user themselves. */
  meParticipantId: string;
  /** replica_participants.id of the person the replica should imitate. */
  replicaParticipantId: string;
};

/**
 * Apply the user's ME / REPLICA choice.
 * Stores roles, stamps every message with the correct role, and rebuilds the
 * style profile from the SELECTED person's messages only.
 */
export async function finalizeParticipantRoles(choice: ParticipantChoice): Promise<{
  replicaMessages: number;
  replicaName: string;
}> {
  if (choice.meParticipantId === choice.replicaParticipantId) {
    throw new AppError("ME and REPLICA must be two different people.", { kind: "validation" });
  }
  const supabase = await getSupabase();

  const { data: participants, error: participantsError } = await supabase
    .from("replica_participants")
    .select("id, display_name")
    .eq("replica_id", choice.replicaId);
  if (participantsError) throw stageError("Saving participants", participantsError, "database");

  const replicaParticipant = (participants ?? []).find((p) => p.id === choice.replicaParticipantId);
  if (!replicaParticipant) {
    throw new AppError("The selected replica participant no longer exists.", { kind: "validation" });
  }

  // Roles + message stamping happen entirely database-side: three set-based
  // statements inside one RPC instead of N browser round trips (which timed out
  // on 300k-message replicas). Ownership is re-checked inside the function.
  const { error: rolesError } = await supabase.rpc("assign_participant_roles", {
    p_replica_id: choice.replicaId,
    p_me: choice.meParticipantId,
    p_replica: choice.replicaParticipantId,
  });
  if (rolesError) throw stageError("Saving participants", rolesError, "database");


  // Rebuild the style profile from the SELECTED person's own messages only.
  const { data: replicaMessages, error: messagesError } = await supabase
    .from("messages")
    .select("sender_name, message_text, sent_at, message_type")
    .eq("replica_id", choice.replicaId)
    .eq("sender_role", "replica")
    .not("message_text", "is", null)
    .order("sent_at", { ascending: false })
    .limit(5000);
  if (messagesError) throw stageError("Analyzing style", messagesError, "database");

  const styleInput = (replicaMessages ?? []).map((row) => ({
    senderName: row.sender_name ?? replicaParticipant.display_name,
    text: row.message_text ?? "",
    sentAt: row.sent_at ?? null,
    messageType: row.message_type === "media" ? ("media" as const) : ("text" as const),
  }));
  const style = analyzeStyle(styleInput);
  const { error: styleError } = await supabase.from("replica_style_profiles").upsert(
    {
      replica_id: choice.replicaId,
      owner_id: choice.ownerId,
      ...style,
      analysis_version: 2,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "replica_id" },
  );
  if (styleError) throw stageError("Analyzing style", styleError, "database");

  const { error: replicaError } = await supabase
    .from("replicas")
    .update({ status: "ready" })
    .eq("id", choice.replicaId);
  if (replicaError) throw stageError("Finalizing", replicaError, "database");

  return {
    replicaMessages: styleInput.length,
    replicaName: replicaParticipant.display_name as string,
  };
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
  if (error) throw stageError("Preparing", error, "database");
  const { data: blob, error: downloadError } = await supabase.storage
    .from(source!.bucket_name)
    .download(source!.storage_path);
  if (downloadError) throw stageError("Preparing", downloadError, "storage");
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

/** Jobs abandoned by a closed tab are marked failed so nothing stays stuck. */
export async function recoverStaleJobs(staleMinutes = 30): Promise<number> {
  const supabase = await getSupabase();
  const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();
  const { data, error } = await supabase
    .from("processing_jobs")
    .update({
      status: "failed",
      error_message:
        "Import was interrupted (the tab was closed or the connection dropped). Retry it from Import history.",
      completed_at: new Date().toISOString(),
    })
    .eq("status", "processing")
    .lt("started_at", cutoff)
    .select("id");
  if (error) {
    console.warn("[stale jobs]", formatError(error));
    return 0;
  }
  return (data ?? []).length;
}
