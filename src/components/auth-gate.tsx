import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Loader2, ShieldAlert } from "lucide-react";

import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { SignInPanel } from "@/components/sign-in-panel";

/**
 * Client-side gate: Firebase session AND a resolved Supabase identity are both
 * required before any data or storage call is allowed to run.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();

  if (auth.loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="size-6 animate-spin text-primary" aria-label="Loading" />
      </div>
    );
  }

  if (!auth.firebaseUser) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4 py-10">
        <SignInPanel />
      </div>
    );
  }

  if (!auth.authorized) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="max-w-md rounded-xl border border-border bg-card p-6 text-center">
          <ShieldAlert className="mx-auto size-8 text-destructive" aria-hidden />
          <h1 className="mt-3 font-display text-xl font-semibold">Secure bridge not established</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {auth.bridgeError ??
              "Your sign-in worked, but the database could not confirm your identity yet."}
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button onClick={() => void auth.refreshIdentity()}>Retry verification</Button>
            <Button variant="outline" asChild>
              <Link to="/diagnostics">Open diagnostics</Link>
            </Button>
            <Button variant="ghost" onClick={() => void auth.signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return <AppShell>{children}</AppShell>;
}
