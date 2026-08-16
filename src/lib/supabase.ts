import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getPublicConfig } from "./config.functions";
import { getFirebaseAuth } from "./firebase";

/**
 * THE FIREBASE -> SUPABASE BRIDGE
 *
 * Supabase supports Firebase as a Third-Party Auth provider. When registered in
 * the Supabase dashboard (Authentication -> Sign In / Providers -> Third-Party Auth),
 * Supabase validates the Firebase ID token itself, and inside Postgres:
 *
 *   auth.jwt() ->> 'sub'   ==   the Firebase UID
 *   auth.role()            ==   'authenticated'
 *
 * We therefore pass the LIVE Firebase ID token through the supabase-js
 * `accessToken` hook. supabase-js calls it before every request, so token refresh
 * is automatic (getIdToken() refreshes when near expiry). We never store the token
 * ourselves and never call supabase.auth.* (disabled when `accessToken` is used).
 */

export type MemoryClient = SupabaseClient;

let clientPromise: Promise<MemoryClient> | null = null;
let publicConfig: { supabaseUrl: string; publishableKey: string; configured: boolean } | null = null;

export async function loadPublicConfig() {
  if (!publicConfig) {
    publicConfig = await getPublicConfig();
  }
  return publicConfig;
}

export async function getFirebaseIdToken(forceRefresh = false): Promise<string | null> {
  const user = getFirebaseAuth().currentUser;
  if (!user) return null;
  try {
    return await user.getIdToken(forceRefresh);
  } catch {
    return null;
  }
}

export async function getSupabase(): Promise<MemoryClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const config = await loadPublicConfig();
      if (!config.configured) {
        throw new Error(
          "Supabase is not configured: missing publishable key. Add MEMORY_SUPABASE_PUBLISHABLE_KEY.",
        );
      }
      return createClient(config.supabaseUrl, config.publishableKey, {
        accessToken: async () => (await getFirebaseIdToken()) ?? "",
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: { "x-client-info": "always-together-web" } },
      });
    })();
  }
  return clientPromise;
}

/** Identity as Postgres sees it — the single source of truth for "am I authorized". */
export async function resolveSupabaseIdentity(): Promise<{
  uid: string | null;
  role: string | null;
  error: string | null;
}> {
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase.rpc("current_identity");
    if (error) return { uid: null, role: null, error: error.message };
    const row = Array.isArray(data) ? data[0] : data;
    return { uid: row?.uid ?? null, role: row?.role ?? null, error: null };
  } catch (error) {
    return { uid: null, role: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Translate raw Postgres/Storage failures into layer-specific, actionable messages. */
export function explainSupabaseError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "Unknown error");
  const code = (error as { code?: string } | null)?.code ?? "";
  const status = (error as { status?: number } | null)?.status;

  if (code === "42501" || /row-level security/i.test(raw)) {
    return "Authorization layer (RLS) rejected this operation. Your Supabase identity does not own this row/path — check the auth bridge in Diagnostics rather than loosening policies.";
  }
  if (status === 401 || /jwt|invalid token|unauthorized/i.test(raw)) {
    return "Supabase rejected the Firebase token (401). The Firebase project must be registered as a Third-Party Auth provider in Supabase, and you must be signed in.";
  }
  if (code === "42P01" || /does not exist/i.test(raw)) {
    return "Database schema is missing. Run the setup SQL from the Setup page in your Supabase SQL editor.";
  }
  if (code === "23505" || /duplicate key/i.test(raw)) {
    return "This record already exists.";
  }
  if (/Bucket not found/i.test(raw)) {
    return "Storage bucket not found. Create the 'memories' and 'chat-uploads' buckets in Supabase Storage.";
  }
  if (/Failed to fetch|NetworkError|network/i.test(raw)) {
    return "Network error reaching Supabase. Check your connection and try again.";
  }
  return raw;
}
