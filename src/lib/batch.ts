/**
 * Resilient batched writes for very large imports (300k+ rows).
 *
 * Why this exists: a single long-lived request chain is fragile. Sending 300k
 * rows as ~750 sequential inserts with a job update after each one means ~1500
 * round trips, any one of which can be cancelled by the browser, a proxy, or a
 * mobile network — that is the "import cancelled / timed out" failure.
 *
 * The rules here:
 *  - large batches (fewer round trips),
 *  - bounded concurrency (throughput without overwhelming the connection),
 *  - per-batch retry with backoff for transient network/timeout errors,
 *  - a checkpoint so a re-run skips work that already landed (resumable),
 *  - progress reported by batch, never per row.
 */
import { AppError, formatError } from "./errors";

export type BatchOptions = {
  /** Rows per insert request. */
  batchSize?: number;
  /** How many inserts may be in flight at once. */
  concurrency?: number;
  /** Retries per batch before the import fails. */
  retries?: number;
  onBatch?: (info: { rows: number; total: number }) => void;
  signal?: AbortSignal;
};

const TRANSIENT = /fetch|network|timeout|aborted|failed to fetch|502|503|504|econn|socket|canceled|cancelled|terminated/i;

export function isTransient(error: unknown): boolean {
  return TRANSIENT.test(formatError(error));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `write` over `rows` in batches. `write` must be idempotent-safe enough to
 * be retried (plain inserts are, since a failed insert writes nothing).
 */
export async function writeInBatches<T>(
  rows: T[],
  write: (batch: T[], batchIndex: number) => Promise<void>,
  options: BatchOptions = {},
): Promise<number> {
  const batchSize = options.batchSize ?? 1000;
  const concurrency = Math.max(1, options.concurrency ?? 3);
  const retries = options.retries ?? 4;

  const batches: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    batches.push(rows.slice(offset, offset + batchSize));
  }

  let written = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < batches.length) {
      if (options.signal?.aborted) throw new AppError("Import cancelled.", { kind: "validation" });
      const index = cursor;
      cursor += 1;
      const batch = batches[index]!;

      let lastError: unknown = null;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          await write(batch, index);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          // Non-transient failures (schema/RLS) will never succeed on retry.
          if (!isTransient(error) || attempt === retries) break;
          await sleep(Math.min(8000, 400 * 2 ** attempt) + Math.random() * 250);
        }
      }
      if (lastError) throw lastError;

      written += batch.length;
      options.onBatch?.({ rows: written, total: rows.length });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  return written;
}

/* ----------------------------------------------------------- checkpointing */

type Checkpoint = { key: string; done: string[]; updatedAt: number };
const CHECKPOINT_PREFIX = "at:import:";
const CHECKPOINT_TTL = 7 * 24 * 60 * 60 * 1000;

function readCheckpoint(key: string): Checkpoint | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(CHECKPOINT_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Checkpoint;
    if (!parsed.updatedAt || Date.now() - parsed.updatedAt > CHECKPOINT_TTL) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Tracks which units of work (e.g. "conv:3:batch:12") already succeeded. */
export function createCheckpoint(key: string) {
  const existing = readCheckpoint(key);
  const done = new Set(existing?.done ?? []);
  let dirty = false;

  const flush = () => {
    if (!dirty || typeof localStorage === "undefined") return;
    dirty = false;
    try {
      localStorage.setItem(
        CHECKPOINT_PREFIX + key,
        JSON.stringify({ key, done: [...done], updatedAt: Date.now() } satisfies Checkpoint),
      );
    } catch {
      /* quota — checkpointing is best-effort */
    }
  };

  return {
    has: (unit: string) => done.has(unit),
    mark: (unit: string) => {
      done.add(unit);
      dirty = true;
      if (done.size % 5 === 0) flush();
    },
    flush,
    clear: () => {
      done.clear();
      if (typeof localStorage !== "undefined") {
        try {
          localStorage.removeItem(CHECKPOINT_PREFIX + key);
        } catch {
          /* ignore */
        }
      }
    },
    resumedFrom: existing ? done.size : 0,
  };
}

/** Only forward progress/job updates every `intervalMs` — avoids write storms. */
export function throttle<Args extends unknown[]>(
  fn: (...args: Args) => void,
  intervalMs: number,
): (...args: Args) => void {
  let last = 0;
  return (...args: Args) => {
    const now = Date.now();
    if (now - last < intervalMs) return;
    last = now;
    fn(...args);
  };
}
