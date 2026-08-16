import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";

import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";
import { SignInPanel } from "@/components/sign-in-panel";
import { Button } from "@/components/ui/button";
import { getFirebaseIdToken, getSupabase, loadPublicConfig } from "@/lib/supabase";
import { BUCKET_CHAT_UPLOADS, BUCKET_MEMORIES } from "@/lib/data";

export const Route = createFileRoute("/diagnostics")({
  head: () => ({
    meta: [
      { title: "Auth diagnostics — Always Together" },
      { name: "description", content: "Verify Firebase and database authentication layers." },
      { property: "og:title", content: "Auth diagnostics — Always Together" },
      {
        property: "og:description",
        content: "Verify Firebase and database authentication layers.",
      },
    ],
  }),
  component: DiagnosticsPage,
});

type Check = { label: string; status: "pending" | "ok" | "fail"; detail: string };

function DiagnosticsPage() {
  const auth = useAuth();
  const [checks, setChecks] = useState<Check[]>([]);
  const [running, setRunning] = useState(false);
  const [claims, setClaims] = useState<Record<string, unknown> | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    const results: Check[] = [];
    const push = (label: string, ok: boolean, detail: string) =>
      results.push({ label, status: ok ? "ok" : "fail", detail });

    // Layer 0 — public config
    try {
      const config = await loadPublicConfig();
      push(
        "Database config loaded",
        config.configured,
        config.supabaseUrl ? config.supabaseUrl : "Missing URL or publishable key",
      );
    } catch (error) {
      push("Database config loaded", false, error instanceof Error ? error.message : "failed");
    }

    // Layer 1 — Firebase user
    push(
      "Firebase user session",
      Boolean(auth.firebaseUser),
      auth.firebaseUser
        ? `${auth.firebaseUser.email ?? "no email"} · uid ${auth.firebaseUser.uid}`
        : "No Firebase user signed in",
    );

    // Layer 2 — Firebase ID token + claims
    let token: string | null = null;
    try {
      token = await getFirebaseIdToken(true);
      if (token) {
        const payload = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
        setClaims(payload as Record<string, unknown>);
        push(
          "Firebase ID token issued",
          true,
          `aud ${String((payload as { aud?: string }).aud)} · sub ${String((payload as { sub?: string }).sub)} · exp ${new Date(Number((payload as { exp?: number }).exp) * 1000).toLocaleTimeString()}`,
        );
      } else {
        push("Firebase ID token issued", false, "No token available");
      }
    } catch (error) {
      push("Firebase ID token issued", false, error instanceof Error ? error.message : "failed");
    }

    // Layer 3 — bridge: does the database accept the Firebase token?
    if (token) {
      try {
        const supabase = await getSupabase();
        const { data, error } = await supabase.rpc("current_identity");
        if (error) throw new Error(error.message);
        const row = Array.isArray(data) ? data[0] : data;
        const uid = (row as { firebase_uid?: string } | null)?.firebase_uid ?? null;
        push(
          "Third-party JWT bridge accepted",
          Boolean(uid) && uid === auth.firebaseUser?.uid,
          uid
            ? `Database sees uid ${uid} (role ${(row as { jwt_role?: string }).jwt_role ?? "unknown"})`
            : "Database resolved no identity from the token — check Third-Party Auth registration",
        );
      } catch (error) {
        push(
          "Third-party JWT bridge accepted",
          false,
          error instanceof Error ? error.message : "failed",
        );
      }

      // Layer 4 — RLS-protected read
      try {
        const supabase = await getSupabase();
        const { error, count } = await supabase
          .from("replicas")
          .select("id", { count: "exact", head: true });
        if (error) throw new Error(error.message);
        push("RLS read on replicas", true, `${count ?? 0} row(s) visible to you`);
      } catch (error) {
        push("RLS read on replicas", false, error instanceof Error ? error.message : "failed");
      }

      // Layer 5 — storage access on both buckets
      for (const bucket of [BUCKET_CHAT_UPLOADS, BUCKET_MEMORIES]) {
        try {
          const supabase = await getSupabase();
          const { error } = await supabase.storage
            .from(bucket)
            .list(auth.firebaseUser?.uid ?? "", { limit: 1 });
          if (error) throw new Error(error.message);
          push(`Storage access · ${bucket}`, true, "Listing your own folder succeeded");
        } catch (error) {
          push(
            `Storage access · ${bucket}`,
            false,
            error instanceof Error ? error.message : "failed",
          );
        }
      }
    }

    setChecks(results);
    setRunning(false);
  }, [auth.firebaseUser]);

  useEffect(() => {
    if (auth.firebaseUser) void run();
  }, [auth.firebaseUser, run]);

  if (!auth.firebaseUser) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4 py-10">
        <SignInPanel />
      </div>
    );
  }

  const allOk = checks.length > 0 && checks.every((check) => check.status === "ok");

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-wrap items-center gap-3">
          <div>
            <h1 className="font-display text-2xl font-semibold">Auth diagnostics</h1>
            <p className="text-sm text-muted-foreground">
              Verifies every layer between your sign-in and your private data.
            </p>
          </div>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={() => void auth.refreshIdentity()}>
              Refresh identity
            </Button>
            <Button onClick={() => void run()} disabled={running}>
              {running ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="size-4" aria-hidden />
              )}
              Re-run checks
            </Button>
          </div>
        </header>

        <div
          className={`rounded-lg border p-4 text-sm ${
            allOk
              ? "border-primary/40 bg-primary/10 text-foreground"
              : "border-destructive/40 bg-destructive/10 text-foreground"
          }`}
        >
          {running
            ? "Running checks…"
            : allOk
              ? "All authentication layers verified. Data and storage operations are safe to run."
              : "One or more layers failed. Data operations stay blocked until they pass."}
        </div>

        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {checks.map((check) => (
            <li key={check.label} className="flex items-start gap-3 p-4">
              {check.status === "ok" ? (
                <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
              ) : (
                <XCircle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium">{check.label}</p>
                <p className="break-words text-xs text-muted-foreground">{check.detail}</p>
              </div>
            </li>
          ))}
        </ul>

        {claims && (
          <details className="rounded-lg border border-border bg-card p-4">
            <summary className="cursor-pointer text-sm font-medium">Firebase token claims</summary>
            <pre className="mt-3 max-h-80 overflow-auto rounded bg-muted p-3 text-xs">
              {JSON.stringify(claims, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </AppShell>
  );
}
