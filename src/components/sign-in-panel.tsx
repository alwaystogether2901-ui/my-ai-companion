import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Lock } from "lucide-react";

import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Mode = "signin" | "signup";

export function SignInPanel() {
  const auth = useAuth();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      if (mode === "signup") {
        await auth.signUpWithEmail(email.trim(), password, displayName.trim());
        toast.success("Account created — welcome.");
      } else {
        await auth.signInWithEmail(email.trim(), password);
        toast.success("Signed in.");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    setBusy(true);
    try {
      await auth.signInWithGoogle();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Google sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  async function forgot() {
    if (!email.trim()) {
      toast.error("Enter your email first.");
      return;
    }
    try {
      await auth.resetPassword(email.trim());
      toast.success("Password reset email sent.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send reset email");
    }
  }

  return (
    <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-lg">
      <div className="flex items-center gap-2 text-primary">
        <Lock className="size-5" aria-hidden />
        <span className="text-xs font-semibold uppercase tracking-wider">Private space</span>
      </div>
      <h1 className="mt-3 font-display text-2xl font-semibold">Always Together</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Keep the conversations that matter, and keep talking.
      </p>

      <Tabs value={mode} onValueChange={(value) => setMode(value as Mode)} className="mt-5">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="signin">Sign in</TabsTrigger>
          <TabsTrigger value="signup">Create account</TabsTrigger>
        </TabsList>

        <TabsContent value={mode} className="mt-4">
          <form onSubmit={submit} className="space-y-3">
            {mode === "signup" && (
              <div className="space-y-1.5">
                <Label htmlFor="name">Your name</Label>
                <Input
                  id="name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  autoComplete="name"
                  required
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                minLength={6}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {mode === "signup" ? "Create account" : "Sign in"}
            </Button>
          </form>
        </TabsContent>
      </Tabs>

      <Button variant="outline" className="mt-3 w-full" onClick={google} disabled={busy}>
        Continue with Google
      </Button>

      {mode === "signin" && (
        <button
          type="button"
          onClick={forgot}
          className="mt-3 w-full text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          Forgot your password?
        </button>
      )}

      {!auth.supabaseConfigured && (
        <p className="mt-4 rounded-md bg-destructive/10 p-3 text-xs text-destructive">
          The secure database connection is not configured yet.
        </p>
      )}
    </div>
  );
}
