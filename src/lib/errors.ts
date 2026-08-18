/**
 * CENTRAL ERROR FORMATTER
 *
 * Every failure in this app — Postgres, PostgREST, Storage, Grok, fetch, or a
 * plain thrown object — goes through here. The UI must never render
 * "[object Object]".
 */

export type AppErrorKind =
  | "auth"
  | "bridge"
  | "rls"
  | "schema"
  | "storage"
  | "database"
  | "network"
  | "grok"
  | "parse"
  | "validation"
  | "unknown";

export class AppError extends Error {
  kind: AppErrorKind;
  stage: string | null;
  status: number | null;
  code: string | null;
  detail: string | null;

  constructor(
    message: string,
    options: {
      kind?: AppErrorKind;
      stage?: string | null;
      status?: number | null;
      code?: string | null;
      detail?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.kind = options.kind ?? "unknown";
    this.stage = options.stage ?? null;
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.detail = options.detail ?? null;
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

type LooseError = {
  message?: unknown;
  error?: unknown;
  error_description?: unknown;
  msg?: unknown;
  details?: unknown;
  hint?: unknown;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  name?: unknown;
  originalError?: unknown;
};

function asLoose(error: unknown): LooseError {
  return (error ?? {}) as LooseError;
}

/** Best-effort numeric HTTP status from any error shape. */
export function errorStatus(error: unknown): number | null {
  const loose = asLoose(error);
  const raw = loose.status ?? loose.statusCode;
  const parsed = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function errorCode(error: unknown): string | null {
  const loose = asLoose(error);
  return typeof loose.code === "string" && loose.code ? loose.code : null;
}

/** Human-readable core message, never "[object Object]". */
export function errorMessage(error: unknown): string {
  if (error == null) return "Unknown error";
  if (typeof error === "string") return error;
  if (error instanceof Error && error.message) return error.message;

  const loose = asLoose(error);
  for (const candidate of [loose.message, loose.error_description, loose.msg, loose.error]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  if (loose.error && typeof loose.error === "object") {
    const nested = errorMessage(loose.error);
    if (nested && nested !== "Unknown error") return nested;
  }
  try {
    const json = JSON.stringify(error);
    if (json && json !== "{}" && json !== "null") return json.slice(0, 500);
  } catch {
    /* circular */
  }
  return "Unknown error";
}

/** Full technical detail line: status, code, details, hint. */
export function errorDetail(error: unknown): string | null {
  const loose = asLoose(error);
  const parts: string[] = [];
  const status = errorStatus(error);
  if (status) parts.push(`HTTP ${status}`);
  const code = errorCode(error);
  if (code) parts.push(`code ${code}`);
  if (typeof loose.details === "string" && loose.details) parts.push(loose.details);
  if (typeof loose.hint === "string" && loose.hint) parts.push(`hint: ${loose.hint}`);
  return parts.length ? parts.join(" · ") : null;
}

function classify(error: unknown): AppErrorKind {
  const message = errorMessage(error).toLowerCase();
  const code = errorCode(error) ?? "";
  const status = errorStatus(error);

  if (code === "42501" || message.includes("row-level security") || message.includes("violates row")) {
    return "rls";
  }
  if (code === "42P01" || code === "42703" || code === "PGRST204" || code === "PGRST202") {
    return "schema";
  }
  if (status === 401 || status === 403 || message.includes("jwt") || message.includes("unauthorized")) {
    return "auth";
  }
  if (
    message.includes("bucket") ||
    message.includes("payload too large") ||
    message.includes("exceeded the maximum allowed size") ||
    message.includes("mime type")
  ) {
    return "storage";
  }
  if (message.includes("failed to fetch") || message.includes("networkerror") || message.includes("load failed")) {
    return "network";
  }
  return "unknown";
}

const FRIENDLY: Partial<Record<AppErrorKind, string>> = {
  rls: "Authorization (row-level security) rejected this operation — your identity does not own this row or path.",
  schema: "The database schema is missing something this app needs. Open Diagnostics and run the generated migration.",
  auth: "Your session was rejected. Sign in again, then retry.",
  network: "Network error. Check your connection and retry.",
};

/**
 * The single formatter used by every catch block.
 * `stage` names the pipeline step so users see e.g.
 * "Chat upload failed at Storage upload — HTTP 413 Payload too large".
 */
export function formatError(error: unknown, stage?: string): string {
  if (error instanceof AppError) {
    const head = error.stage ? `${error.stage}: ${error.message}` : error.message;
    return error.detail ? `${head} (${error.detail})` : head;
  }

  const kind = classify(error);
  const base = FRIENDLY[kind] ?? errorMessage(error);
  const detail = errorDetail(error);
  const raw = errorMessage(error);
  const parts = [base];
  if (FRIENDLY[kind] && raw && raw !== base) parts.push(raw);
  if (detail) parts.push(detail);
  const message = parts.join(" — ");
  return stage ? `${stage}: ${message}` : message;
}

/** Wrap any thrown value into an AppError that names the failing stage. */
export function stageError(
  stage: string,
  error: unknown,
  kind: AppErrorKind = "unknown",
): AppError {
  if (error instanceof AppError) return error;
  return new AppError(errorMessage(error), {
    kind: classify(error) === "unknown" ? kind : classify(error),
    stage,
    status: errorStatus(error),
    code: errorCode(error),
    detail: errorDetail(error),
    cause: error,
  });
}

/** Safe for React rendering. */
export function toDisplayMessage(error: unknown): string {
  const message = formatError(error);
  return message === "[object Object]" ? "Unexpected error" : message;
}
