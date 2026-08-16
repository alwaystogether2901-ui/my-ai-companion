/**
 * SERVER-ONLY: verifies a Firebase ID token before any privileged work.
 * Uses Google's Secure Token / Identity Toolkit endpoint, which validates the
 * signature, audience, expiry and revocation state for us — no key handling here.
 */
const FIREBASE_API_KEY =
  process.env["FIREBASE_API_KEY"] ?? "AIzaSyBFwDbVeTNPhGLJZ5vwxYQd_k8ltwXEw5g";

export type VerifiedFirebaseUser = { uid: string; email: string | null; displayName: string | null };

export async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedFirebaseUser> {
  if (!idToken || idToken.split(".").length !== 3) {
    throw new Error("Missing or malformed Firebase ID token");
  }
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken }),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    console.error(`[firebase verify] ${response.status}: ${body}`);
    throw new Error("Your session has expired. Sign in again.");
  }
  const payload = (await response.json()) as {
    users?: { localId: string; email?: string; displayName?: string; disabled?: boolean }[];
  };
  const user = payload.users?.[0];
  if (!user?.localId) throw new Error("Firebase token did not resolve to a user");
  if (user.disabled) throw new Error("This account is disabled");
  return {
    uid: user.localId,
    email: user.email ?? null,
    displayName: user.displayName ?? null,
  };
}

/** Supabase client that acts AS the Firebase user (RLS applies, no service key). */
export async function createUserScopedSupabase(idToken: string) {
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env["MEMORY_SUPABASE_URL"] ?? "https://lqozgmshdwvfbeyonmpy.supabase.co";
  const key = process.env["MEMORY_SUPABASE_PUBLISHABLE_KEY"];
  if (!key) throw new Error("Server is missing MEMORY_SUPABASE_PUBLISHABLE_KEY");
  return createClient(url, key, {
    accessToken: async () => idToken,
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
