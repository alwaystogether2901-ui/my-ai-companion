import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Loader2 } from "lucide-react";

import { useAuth } from "@/lib/auth";
import { SignInPanel } from "@/components/sign-in-panel";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Always Together — Private AI Memory Chat" },
      {
        name: "description",
        content:
          "Import your chat history, build a private AI replica of someone you love, and keep the conversation going.",
      },
      { property: "og:title", content: "Always Together — Private AI Memory Chat" },
      {
        property: "og:description",
        content:
          "Import your chat history, build a private AI replica, and keep the conversation going.",
      },
    ],
  }),
  component: Landing,
});

function Landing() {
  const auth = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!auth.loading && auth.firebaseUser) {
      navigate({ to: "/chat", replace: true });
    }
  }, [auth.loading, auth.firebaseUser, navigate]);

  if (auth.loading || auth.firebaseUser) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="size-6 animate-spin text-primary" aria-label="Loading" />
      </div>
    );
  }

  return (
    <div className="grid min-h-screen items-center gap-10 px-4 py-12 lg:grid-cols-2 lg:px-16">
      <section className="mx-auto max-w-xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">
          Private · Encrypted · Yours
        </p>
        <h1 className="mt-4 font-display text-4xl font-semibold leading-tight sm:text-5xl">
          Keep talking to the people who shaped you.
        </h1>
        <p className="mt-5 text-base text-muted-foreground">
          Bring in a WhatsApp export, a JSON archive or a CSV log. Always Together learns how
          someone wrote — their rhythm, their humour, their emoji — and lets you sit with those
          memories again, in a space only you can open.
        </p>
        <ul className="mt-8 space-y-3 text-sm text-muted-foreground">
          <li>· Imports ZIP, TXT, JSON and CSV chat exports</li>
          <li>· Measures language, humour and message style automatically</li>
          <li>· Every file and memory is locked to your account alone</li>
        </ul>
      </section>
      <div className="flex justify-center lg:justify-end">
        <SignInPanel />
      </div>
    </div>
  );
}
