import JSZip from "jszip";

export type ParsedMessage = {
  senderName: string;
  text: string;
  sentAt: string | null;
  messageType: "text" | "media";
  mediaHint?: string;
  originalMessageId?: string;
  replyToMessageId?: string;
};

export type ParsedConversation = {
  title: string;
  sourcePlatform: string;
  messages: ParsedMessage[];
};

export type ParseResult = {
  conversations: ParsedConversation[];
  mediaFiles: { name: string; blob: Blob }[];
  detectedFormat: string;
};

export class UnsupportedFormatError extends Error {
  constructor(detail: string) {
    super(`Unsupported or unrecognized conversation format. ${detail}`);
    this.name = "UnsupportedFormatError";
  }
}

const TEXT_EXTENSIONS = [".txt", ".json", ".csv", ".md", ".log"];
const MEDIA_EXTENSIONS = [
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic",
  ".mp4", ".mov", ".webm",
  ".mp3", ".ogg", ".opus", ".wav", ".m4a", ".aac",
];

export function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index).toLowerCase();
}

export function isMediaFile(name: string): boolean {
  return MEDIA_EXTENSIONS.includes(extensionOf(name));
}

export function guessMediaType(name: string): "image" | "video" | "audio" | "file" {
  const ext = extensionOf(name);
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic"].includes(ext)) return "image";
  if ([".mp4", ".mov", ".webm"].includes(ext)) return "video";
  if ([".mp3", ".ogg", ".opus", ".wav", ".m4a", ".aac"].includes(ext)) return "audio";
  return "file";
}

/* ------------------------------------------------------------------ WhatsApp */
// 12/05/2023, 21:14 - Alice: hey    |    [12/05/23, 9:14:03 PM] Alice: hey
const WA_PATTERNS = [
  /^\[?(\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap][Mm])?)\]?\s*[-–]?\s*([^:]{1,60}?):\s?([\s\S]*)$/,
];

function parseLooseDate(datePart: string, timePart: string): string | null {
  const cleaned = `${datePart} ${timePart}`.replace(/\u202f/g, " ").trim();
  const segments = datePart.split(/[/.-]/).map((v) => parseInt(v, 10));
  if (segments.length === 3 && segments.every((n) => !Number.isNaN(n))) {
    let [a, b, c] = segments as [number, number, number];
    let year = c < 100 ? 2000 + c : c;
    let day = a;
    let month = b;
    if (a > 31) {
      year = a;
      month = b;
      day = c;
    } else if (a > 12 && b <= 12) {
      day = a;
      month = b;
    } else if (b > 12) {
      month = a;
      day = b;
    }
    const timeMatch = timePart.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([APap][Mm])?/);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1]!, 10);
      const minutes = parseInt(timeMatch[2]!, 10);
      const seconds = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
      const meridiem = timeMatch[4]?.toLowerCase();
      if (meridiem === "pm" && hours < 12) hours += 12;
      if (meridiem === "am" && hours === 12) hours = 0;
      const date = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  const fallback = new Date(cleaned);
  return Number.isNaN(fallback.getTime()) ? null : fallback.toISOString();
}

function parseWhatsAppText(content: string, title: string): ParsedConversation | null {
  const lines = content.split(/\r?\n/);
  const messages: ParsedMessage[] = [];
  let matched = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let handled = false;
    for (const pattern of WA_PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        matched += 1;
        const [, datePart, timePart, sender, text] = match;
        const body = (text ?? "").trim();
        const isMedia = /<Media omitted>|\(file attached\)|image omitted|video omitted|audio omitted|sticker omitted/i.test(
          body,
        );
        messages.push({
          senderName: (sender ?? "Unknown").trim(),
          text: body,
          sentAt: parseLooseDate(datePart ?? "", timePart ?? ""),
          messageType: isMedia ? "media" : "text",
          ...(isMedia ? { mediaHint: body } : {}),
        });
        handled = true;
        break;
      }
    }
    if (!handled && messages.length > 0) {
      const last = messages[messages.length - 1]!;
      last.text = `${last.text}\n${line.trim()}`.trim();
    }
  }

  if (matched < 3) return null;
  return { title, sourcePlatform: "whatsapp", messages };
}

/** Generic "Name: message" transcript. */
function parsePlainTranscript(content: string, title: string): ParsedConversation | null {
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  const messages: ParsedMessage[] = [];
  for (const line of lines) {
    const match = line.match(/^([^:]{1,40}):\s?(.+)$/);
    if (match) {
      messages.push({
        senderName: match[1]!.trim(),
        text: match[2]!.trim(),
        sentAt: null,
        messageType: "text",
      });
    } else if (messages.length > 0) {
      messages[messages.length - 1]!.text += `\n${line.trim()}`;
    }
  }
  if (messages.length < 3) return null;
  const senders = new Set(messages.map((m) => m.senderName));
  if (senders.size < 2) return null;
  return { title, sourcePlatform: "transcript", messages };
}

/* ---------------------------------------------------------------------- JSON */
function pick<T = unknown>(row: Record<string, unknown>, keys: string[]): T | undefined {
  for (const key of keys) {
    const found = Object.keys(row).find((k) => k.toLowerCase() === key);
    if (found && row[found] !== null && row[found] !== undefined) return row[found] as T;
  }
  return undefined;
}

function normalizeRow(row: Record<string, unknown>): ParsedMessage | null {
  const sender =
    pick<string>(row, ["sender_name", "sender", "author", "from", "name", "user", "participant", "role"]) ??
    undefined;
  const rawText =
    pick<string>(row, ["content", "text", "message", "body", "message_text", "value", "caption"]) ??
    undefined;
  if (!sender && !rawText) return null;
  const timestamp = pick<string | number>(row, [
    "timestamp_ms", "timestamp", "date", "time", "created_at", "sent_at", "datetime",
  ]);
  let sentAt: string | null = null;
  if (typeof timestamp === "number") {
    const ms = timestamp > 1e12 ? timestamp : timestamp * 1000;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) sentAt = date.toISOString();
  } else if (typeof timestamp === "string") {
    const date = new Date(timestamp);
    if (!Number.isNaN(date.getTime())) sentAt = date.toISOString();
  }
  const media = pick<string>(row, ["media", "uri", "photos", "attachment", "attachments", "audio_files"]);
  const text = typeof rawText === "string" ? rawText : rawText ? JSON.stringify(rawText) : "";
  return {
    senderName: (sender ?? "Unknown").toString(),
    text,
    sentAt,
    messageType: media ? "media" : "text",
    ...(media ? { mediaHint: typeof media === "string" ? media : JSON.stringify(media) } : {}),
    ...(pick<string>(row, ["id", "message_id", "original_message_id"])
      ? { originalMessageId: String(pick<string>(row, ["id", "message_id", "original_message_id"])) }
      : {}),
    ...(pick<string>(row, ["reply_to", "reply_to_message_id", "in_reply_to"])
      ? {
          replyToMessageId: String(
            pick<string>(row, ["reply_to", "reply_to_message_id", "in_reply_to"]),
          ),
        }
      : {}),
  };
}

function collectMessageArrays(value: unknown, depth = 0): Record<string, unknown>[][] {
  if (depth > 6 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    const objects = value.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object");
    if (objects.length >= 3 && objects.some((row) => normalizeRow(row))) return [objects];
    return objects.flatMap((row) => collectMessageArrays(row, depth + 1));
  }
  return Object.values(value as Record<string, unknown>).flatMap((child) =>
    collectMessageArrays(child, depth + 1),
  );
}

function parseJsonContent(content: string, title: string): ParsedConversation[] {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    // JSONL fallback
    const rows = content
      .split(/\r?\n/)
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((row): row is Record<string, unknown> => Boolean(row));
    data = rows;
  }
  const arrays = collectMessageArrays(data);
  const conversations: ParsedConversation[] = [];
  for (const [index, rows] of arrays.entries()) {
    const messages = rows
      .map(normalizeRow)
      .filter((m): m is ParsedMessage => m !== null && Boolean(m.text || m.mediaHint));
    if (messages.length >= 3) {
      conversations.push({
        title: arrays.length > 1 ? `${title} (${index + 1})` : title,
        sourcePlatform: "json",
        messages,
      });
    }
  }
  return conversations;
}

/* ----------------------------------------------------------------------- CSV */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if ((char === "," || char === ";" || char === "\t") && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function parseCsvContent(content: string, title: string): ParsedConversation | null {
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 3) return null;
  const headers = splitCsvLine(lines[0]!).map((h) => h.toLowerCase());
  const messages: ParsedMessage[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const row: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? "";
    });
    const message = normalizeRow(row);
    if (message && (message.text || message.mediaHint)) messages.push(message);
  }
  if (messages.length < 3) return null;
  return { title, sourcePlatform: "csv", messages };
}

/* ---------------------------------------------------------------- Entry point */
function parseTextLike(name: string, content: string): ParsedConversation[] {
  const ext = extensionOf(name);
  const title = name.replace(/\.[^.]+$/, "");
  if (ext === ".json") {
    const conversations = parseJsonContent(content, title);
    if (conversations.length) return conversations;
  }
  if (ext === ".csv") {
    const csv = parseCsvContent(content, title);
    if (csv) return [csv];
  }
  const whatsapp = parseWhatsAppText(content, title);
  if (whatsapp) return [whatsapp];
  const json = parseJsonContent(content, title);
  if (json.length) return json;
  const csv = parseCsvContent(content, title);
  if (csv) return [csv];
  const transcript = parsePlainTranscript(content, title);
  if (transcript) return [transcript];
  return [];
}

export async function parseUploadedFile(
  file: File,
  onProgress?: (message: string, ratio: number) => void,
): Promise<ParseResult> {
  const ext = extensionOf(file.name);

  if (ext === ".zip") {
    onProgress?.("Reading archive", 0.05);
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const entries = Object.values(zip.files).filter((entry) => !entry.dir);
    const conversations: ParsedConversation[] = [];
    const mediaFiles: { name: string; blob: Blob }[] = [];
    let index = 0;
    for (const entry of entries) {
      index += 1;
      onProgress?.(`Scanning ${entry.name}`, 0.05 + (index / Math.max(entries.length, 1)) * 0.35);
      const entryExt = extensionOf(entry.name);
      if (TEXT_EXTENSIONS.includes(entryExt)) {
        const content = await entry.async("string");
        conversations.push(...parseTextLike(entry.name.split("/").pop() ?? entry.name, content));
      } else if (isMediaFile(entry.name) && mediaFiles.length < 60) {
        mediaFiles.push({ name: entry.name.split("/").pop() ?? entry.name, blob: await entry.async("blob") });
      }
    }
    if (!conversations.length) {
      throw new UnsupportedFormatError(
        "The ZIP contained no readable conversation export. Include a WhatsApp .txt export, a JSON/JSONL export, or a CSV with sender/message/timestamp columns.",
      );
    }
    return { conversations, mediaFiles, detectedFormat: "zip" };
  }

  if (TEXT_EXTENSIONS.includes(ext)) {
    onProgress?.("Reading file", 0.1);
    const content = await file.text();
    const conversations = parseTextLike(file.name, content);
    if (!conversations.length) {
      throw new UnsupportedFormatError(
        "Expected a WhatsApp-style transcript (\"12/05/2023, 21:14 - Alice: hi\"), a JSON/JSONL export, or a CSV with sender/message/timestamp columns.",
      );
    }
    return { conversations, mediaFiles: [], detectedFormat: ext.slice(1) };
  }

  throw new UnsupportedFormatError(
    `Files of type "${ext || "unknown"}" cannot be imported. Supported: .zip, .txt, .json, .csv, .md, .log.`,
  );
}
