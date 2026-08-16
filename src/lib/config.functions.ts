import { createServerFn } from "@tanstack/react-start";

/**
 * Public runtime config. Only publishable values are returned here — the Supabase
 * publishable (anon) key is safe in the browser; RLS is what protects the data.
 * Secrets (GROK_API_KEY, service keys) are never part of this payload.
 */
export const getPublicConfig = createServerFn({ method: "GET" }).handler(async () => {
  const supabaseUrl =
    process.env["MEMORY_SUPABASE_URL"] ?? "https://lqozgmshdwvfbeyonmpy.supabase.co";
  const publishableKey = process.env["MEMORY_SUPABASE_PUBLISHABLE_KEY"] ?? "";

  return {
    supabaseUrl,
    publishableKey,
    configured: Boolean(supabaseUrl && publishableKey),
  };
});
