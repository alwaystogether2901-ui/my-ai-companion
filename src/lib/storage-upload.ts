/**
 * DIRECT STORAGE UPLOAD WITH REAL PROGRESS AND REAL ERRORS
 *
 * supabase-js `storage.upload()` buffers the whole body through fetch: no
 * progress events, and Storage failures surface as opaque objects (the source
 * of the "Object error" the ZIP upload showed at ~8%).
 *
 * This uses XHR against the Storage REST endpoint with the live Firebase ID
 * token, so:
 *   - RLS storage policies apply exactly as with supabase-js
 *   - upload.onprogress gives true byte-level progress
 *   - the response body is read, so HTTP status + Storage error code + message
 *     are all surfaced (413 payload too large, 400 mime type, 409 duplicate...)
 */
import { AppError } from "./errors";
import { loadPublicConfig, getFirebaseIdToken, getSupabase } from "./supabase";

export type UploadProgress = { loaded: number; total: number; ratio: number };

type StorageErrorBody = { statusCode?: string; error?: string; message?: string };

function describeStorageFailure(status: number, bodyText: string, fileSize: number): AppError {
  let parsed: StorageErrorBody = {};
  try {
    parsed = JSON.parse(bodyText) as StorageErrorBody;
  } catch {
    /* non-JSON body */
  }
  const raw = parsed.message || parsed.error || bodyText.slice(0, 300) || "no response body";
  const sizeMb = (fileSize / 1024 / 1024).toFixed(1);

  let explanation = raw;
  if (status === 413 || /exceeded the maximum allowed size|payload too large/i.test(raw)) {
    explanation =
      `Storage refused the ${sizeMb} MB file because it is larger than the bucket's file size limit. ` +
      `Raise it in Supabase → Storage → chat-uploads → Settings → File size limit (and the project's global upload limit).`;
  } else if (status === 400 && /mime/i.test(raw)) {
    explanation =
      `Storage refused this file's MIME type. Clear "Allowed MIME types" on the bucket, or add ` +
      `application/zip, application/x-zip-compressed, text/plain, application/json, text/csv, application/octet-stream.`;
  } else if (status === 403 || /row-level security|Unauthorized|new row violates/i.test(raw)) {
    explanation =
      "Storage policies rejected the upload. The object path must start with your own user id folder, " +
      "and the bucket needs the INSERT policy from the Diagnostics migration.";
  } else if (status === 409) {
    explanation = "An object already exists at that path.";
  } else if (status === 404) {
    explanation = "The storage bucket does not exist. Create it in Supabase → Storage.";
  }

  return new AppError(explanation, {
    kind: "storage",
    stage: "Storage upload",
    status,
    code: parsed.statusCode ?? null,
    detail: `HTTP ${status}${parsed.statusCode ? ` · code ${parsed.statusCode}` : ""} · ${raw}`,
  });
}

/** Upload a File/Blob to `bucket/path` with progress. Throws AppError on failure. */
export async function uploadWithProgress(options: {
  bucket: string;
  path: string;
  body: Blob;
  contentType?: string;
  upsert?: boolean;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}): Promise<{ path: string }> {
  const config = await loadPublicConfig();
  if (!config.configured) {
    throw new AppError("Database configuration is missing the publishable key.", {
      kind: "storage",
      stage: "Storage upload",
    });
  }
  const token = await getFirebaseIdToken();
  if (!token) {
    throw new AppError("You are signed out — no Firebase ID token available.", {
      kind: "auth",
      stage: "Storage upload",
    });
  }

  const endpoint = `${config.supabaseUrl.replace(/\/$/, "")}/storage/v1/object/${options.bucket}/${options.path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

  return new Promise<{ path: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(options.upsert ? "PUT" : "POST", endpoint, true);
    xhr.setRequestHeader("authorization", `Bearer ${token}`);
    xhr.setRequestHeader("apikey", config.publishableKey);
    xhr.setRequestHeader("x-upsert", options.upsert ? "true" : "false");
    xhr.setRequestHeader("cache-control", "3600");
    if (options.contentType) xhr.setRequestHeader("content-type", options.contentType);
    xhr.timeout = 30 * 60 * 1000; // large files on mobile networks

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      options.onProgress?.({
        loaded: event.loaded,
        total: event.total,
        ratio: event.total ? event.loaded / event.total : 0,
      });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        options.onProgress?.({ loaded: options.body.size, total: options.body.size, ratio: 1 });
        resolve({ path: options.path });
      } else {
        reject(describeStorageFailure(xhr.status, xhr.responseText ?? "", options.body.size));
      }
    };
    xhr.onerror = () =>
      reject(
        new AppError(
          "The network connection dropped during upload. On mobile data, stay on the page and retry.",
          { kind: "network", stage: "Storage upload" },
        ),
      );
    xhr.ontimeout = () =>
      reject(
        new AppError("The upload timed out before completing.", {
          kind: "network",
          stage: "Storage upload",
        }),
      );
    xhr.onabort = () =>
      reject(new AppError("Upload cancelled.", { kind: "storage", stage: "Storage upload" }));
    options.signal?.addEventListener("abort", () => xhr.abort(), { once: true });

    xhr.send(options.body);
  });
}

/** Confirm the object is really there (and readable) after upload. */
export async function verifyStorageObject(bucket: string, path: string): Promise<number | null> {
  const supabase = await getSupabase();
  const folder = path.split("/").slice(0, -1).join("/");
  const name = path.split("/").pop() ?? "";
  const { data, error } = await supabase.storage.from(bucket).list(folder, { search: name, limit: 20 });
  if (error) {
    throw new AppError(error.message, {
      kind: "storage",
      stage: "Verifying upload",
      detail: "Listing the uploaded folder failed — check the bucket SELECT policy.",
    });
  }
  const match = (data ?? []).find((entry) => entry.name === name);
  if (!match) {
    throw new AppError("The uploaded object could not be found in storage afterwards.", {
      kind: "storage",
      stage: "Verifying upload",
    });
  }
  const size = (match.metadata as { size?: number } | null)?.size;
  return typeof size === "number" ? size : null;
}

export type BucketProbe = {
  bucket: string;
  exists: boolean;
  readable: boolean;
  fileSizeLimit: number | null;
  allowedMimeTypes: string[] | null;
  isPublic: boolean | null;
  error: string | null;
};

/** Inspect a bucket's configuration as far as the publishable key allows. */
export async function probeBucket(bucket: string, userFolder: string): Promise<BucketProbe> {
  const supabase = await getSupabase();
  const probe: BucketProbe = {
    bucket,
    exists: false,
    readable: false,
    fileSizeLimit: null,
    allowedMimeTypes: null,
    isPublic: null,
    error: null,
  };
  const { data: info, error: infoError } = await supabase.storage.getBucket(bucket);
  if (info) {
    probe.exists = true;
    probe.fileSizeLimit = (info as { file_size_limit?: number | null }).file_size_limit ?? null;
    probe.allowedMimeTypes = (info as { allowed_mime_types?: string[] | null }).allowed_mime_types ?? null;
    probe.isPublic = (info as { public?: boolean }).public ?? null;
  } else if (infoError) {
    probe.error = infoError.message;
  }
  const { error: listError } = await supabase.storage.from(bucket).list(userFolder, { limit: 1 });
  if (listError) {
    probe.error = probe.error ?? listError.message;
    if (/not found/i.test(listError.message)) probe.exists = false;
  } else {
    probe.exists = true;
    probe.readable = true;
  }
  return probe;
}
