import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, RotateCcw, Send, Trash2 } from "lucide-react";

import { AuthGate } from "@/components/auth-gate";
import { assertAuthorized, useAuth } from "@/lib/auth";
import {
  createSession,
  deleteSession,
  insertSessionMessage,
  listReplicas,
  listSessionMessages,
  listSessions,
  type ChatMessage,
} from "@/lib/data";
import { getFirebaseIdToken } from "@/lib/supabase";
import { generateReply } from "@/lib/grok.functions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/chat")({
  validateSearch: (search: Record<string, unknown>): { replica?: string; session?: string } => ({
    ...(typeof search["replica"] === "string" ? { replica: search["replica"] } : {}),
    ...(typeof search["session"] === "string" ? { session: search["session"] } : {}),
  }),
  head: () => ({
    meta: [
      { title: "Chat — Always Together" },
      {
        name: "description",
        content: "Talk with your private AI replicas, grounded in your own conversations.",
      },
      { property: "og:title", content: "Chat — Always Together" },
      {
        property: "og:description",
        content: "Talk with your private AI replicas, grounded in your own conversations.",
      },
    ],
  }),
  component: () => (
    <AuthGate>
      <ChatPage />
    </AuthGate>
  ),
});

function ChatPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = Route.useSearch();
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [lastFailed, setLastFailed] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const replicas = useQuery({ queryKey: ["replicas"], queryFn: listReplicas });
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: listSessions });

  const activeReplicaId = useMemo(() => {
    if (search.replica) return search.replica;
    const ready = (replicas.data ?? []).find((replica) => replica.status === "ready");
    return ready?.id ?? replicas.data?.[0]?.id ?? null;
  }, [search.replica, replicas.data]);

  const replicaSessions = (sessions.data ?? []).filter(
    (session) => session.replica_id === activeReplicaId,
  );
  const activeSessionId = search.session ?? replicaSessions[0]?.id ?? null;

  const messages = useQuery({
    queryKey: ["session-messages", activeSessionId],
    queryFn: () => listSessionMessages(activeSessionId!),
    enabled: Boolean(activeSessionId),
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.data?.length, pending]);

  const newSession = useMutation({
    mutationFn: async () => {
      const ownerId = assertAuthorized(auth);
      if (!activeReplicaId) throw new Error("Create a replica first.");
      const replica = (replicas.data ?? []).find((item) => item.id === activeReplicaId);
      return createSession(ownerId, activeReplicaId, `Chat with ${replica?.name ?? "replica"}`);
    },
    onSuccess: (session) => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      navigate({ to: "/chat", search: { replica: activeReplicaId!, session: session.id } });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const removeSession = useMutation({
    mutationFn: (id: string) => deleteSession(id),
    onSuccess: () => {
      toast.success("Conversation deleted.");
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      navigate({
        to: "/chat",
        search: activeReplicaId ? { replica: activeReplicaId } : {},
      });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const send = useMutation({
    mutationFn: async (text: string) => {
      const ownerId = assertAuthorized(auth);
      if (!activeReplicaId) throw new Error("Create a replica first.");

      let sessionId = activeSessionId;
      if (!sessionId) {
        const replica = (replicas.data ?? []).find((item) => item.id === activeReplicaId);
        const session = await createSession(
          ownerId,
          activeReplicaId,
          `Chat with ${replica?.name ?? "replica"}`,
        );
        sessionId = session.id;
        await queryClient.invalidateQueries({ queryKey: ["sessions"] });
        navigate({ to: "/chat", search: { replica: activeReplicaId, session: sessionId } });
      }

      await insertSessionMessage(ownerId, {
        session_id: sessionId,
        sender_role: "user",
        message_text: text,
      });
      await queryClient.invalidateQueries({ queryKey: ["session-messages", sessionId] });

      const idToken = await getFirebaseIdToken(true);
      if (!idToken) throw new Error("Your session expired. Sign in again.");

      const result = await generateReply({
        data: {
          idToken,
          replicaId: activeReplicaId,
          sessionId,
          message: text,
        },
      });
      if (!result.ok) throw new Error(result.error ?? "The reply could not be generated.");
      return { sessionId, result };
    },
    onMutate: (text) => {
      setPending(text);
      setDraft("");
      setLastFailed(null);
    },
    onSuccess: ({ sessionId }) => {
      setPending(null);
      void queryClient.invalidateQueries({ queryKey: ["session-messages", sessionId] });
    },
    onError: (error: Error, text) => {
      setPending(null);
      setLastFailed(text);
      toast.error(error.message);
    },
  });

  if (!replicas.isLoading && !replicas.data?.length) {
    return (
      <div className="rounded-xl border border-dashed border-border p-10 text-center">
        <p className="font-medium">No replicas yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Import a conversation export and your first replica is created automatically.
        </p>
        <Button asChild className="mt-4">
          <Link to="/upload">Import a conversation</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
      <aside className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="replica-select" className="text-xs font-medium text-muted-foreground">
            Replica
          </label>
          <Select
            value={activeReplicaId ?? ""}
            onValueChange={(value) => navigate({ to: "/chat", search: { replica: value } })}
          >
            <SelectTrigger id="replica-select">
              <SelectValue placeholder="Choose a replica" />
            </SelectTrigger>
            <SelectContent>
              {(replicas.data ?? []).map((replica) => (
                <SelectItem key={replica.id} value={replica.id}>
                  {replica.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          variant="outline"
          className="w-full"
          onClick={() => newSession.mutate()}
          disabled={newSession.isPending || !activeReplicaId}
        >
          <Plus className="size-4" aria-hidden />
          New conversation
        </Button>

        <ul className="space-y-1">
          {replicaSessions.map((session) => (
            <li key={session.id} className="flex items-center gap-1">
              <Link
                to="/chat"
                search={{
                  ...(activeReplicaId ? { replica: activeReplicaId } : {}),
                  session: session.id,
                }}
                className={cn(
                  "min-w-0 flex-1 truncate rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground",
                  session.id === activeSessionId && "bg-accent text-foreground",
                )}
              >
                {session.title ?? "Untitled"}
              </Link>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Delete conversation"
                onClick={() => removeSession.mutate(session.id)}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex min-h-[70vh] flex-col rounded-xl border border-border bg-card">
        <ScrollArea className="flex-1 p-4">
          <div className="space-y-3">
            {messages.isLoading && activeSessionId ? (
              <Loader2 className="mx-auto size-5 animate-spin text-primary" aria-label="Loading" />
            ) : !messages.data?.length && !pending ? (
              <p className="py-16 text-center text-sm text-muted-foreground">
                Say something to start the conversation.
              </p>
            ) : null}

            {(messages.data ?? []).map((message) => (
              <Bubble key={message.id} message={message} />
            ))}

            {pending && (
              <>
                <div className="ml-auto max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-sm text-primary-foreground">
                  {pending}
                </div>
                <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-muted px-4 py-3">
                  <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Typing" />
                </div>
              </>
            )}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>

        {lastFailed && (
          <div className="mx-4 mb-2 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs">
            <span className="flex-1">That message didn't get a reply.</span>
            <Button size="sm" variant="outline" onClick={() => send.mutate(lastFailed)}>
              <RotateCcw className="size-4" aria-hidden />
              Retry
            </Button>
          </div>
        )}

        <form
          className="flex items-end gap-2 border-t border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            const text = draft.trim();
            if (!text || send.isPending) return;
            send.mutate(text);
          }}
        >
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                const text = draft.trim();
                if (text && !send.isPending) send.mutate(text);
              }
            }}
            rows={2}
            placeholder="Write a message…"
            aria-label="Message"
            className="min-h-11 resize-none"
          />
          <Button type="submit" size="icon" disabled={!draft.trim() || send.isPending}>
            {send.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Send className="size-4" aria-hidden />
            )}
          </Button>
        </form>
      </section>
    </div>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  const mine = message.sender_role === "user";
  return (
    <div
      className={cn(
        "max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm",
        mine
          ? "ml-auto rounded-br-sm bg-primary text-primary-foreground"
          : "rounded-bl-sm bg-muted text-foreground",
      )}
    >
      {message.message_text}
      <span
        className={cn(
          "mt-1 block text-[10px]",
          mine ? "text-primary-foreground/70" : "text-muted-foreground",
        )}
      >
        {new Date(message.created_at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </span>
    </div>
  );
}
