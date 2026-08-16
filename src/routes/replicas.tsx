import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, MessageCircle, Trash2, Users } from "lucide-react";

import { AuthGate } from "@/components/auth-gate";
import { assertAuthorized, useAuth } from "@/lib/auth";
import {
  createReplica,
  deleteReplica,
  getStyleProfile,
  listParticipants,
  listReplicas,
  saveCustomInstructions,
  setParticipantRole,
  updateReplica,
} from "@/lib/data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/replicas")({
  head: () => ({
    meta: [
      { title: "Your replicas — Always Together" },
      {
        name: "description",
        content: "Manage the AI replicas built from your imported conversations.",
      },
      { property: "og:title", content: "Your replicas — Always Together" },
      {
        property: "og:description",
        content: "Manage the AI replicas built from your imported conversations.",
      },
    ],
  }),
  component: () => (
    <AuthGate>
      <ReplicasPage />
    </AuthGate>
  ),
});

function ReplicasPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const replicas = useQuery({ queryKey: ["replicas"], queryFn: listReplicas });

  const create = useMutation({
    mutationFn: async () => {
      const ownerId = assertAuthorized(auth);
      return createReplica(ownerId, { name: name.trim(), description: description.trim() });
    },
    onSuccess: () => {
      setName("");
      setDescription("");
      toast.success("Replica created. Import a conversation to teach it.");
      void queryClient.invalidateQueries({ queryKey: ["replicas"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const ownerId = assertAuthorized(auth);
      await deleteReplica(ownerId, id);
    },
    onSuccess: () => {
      toast.success("Replica and all of its data deleted.");
      void queryClient.invalidateQueries();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold">Your replicas</h1>
          <p className="text-sm text-muted-foreground">
            Each replica learns from the conversations you import.
          </p>
        </div>
        <Dialog>
          <DialogTrigger asChild>
            <Button className="ml-auto">New replica</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create a replica</DialogTitle>
              <DialogDescription>
                Give it a name now — you can import their messages next.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="replica-name">Name</Label>
                <Input
                  id="replica-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Mum"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="replica-description">Who are they to you?</Label>
                <Textarea
                  id="replica-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={3}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={() => create.mutate()}
                disabled={!name.trim() || create.isPending}
              >
                {create.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </header>

      {replicas.isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="size-6 animate-spin text-primary" aria-label="Loading" />
        </div>
      ) : replicas.isError ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
          {(replicas.error as Error).message}
        </p>
      ) : !replicas.data?.length ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <Users className="mx-auto size-8 text-muted-foreground" aria-hidden />
          <p className="mt-3 font-medium">No replicas yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Import a chat export and a replica is created for you automatically.
          </p>
          <Button asChild className="mt-4">
            <Link to="/upload">Import a conversation</Link>
          </Button>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {replicas.data.map((replica) => (
            <li key={replica.id} className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-start gap-3">
                <div className="min-w-0">
                  <h2 className="truncate font-display text-lg font-semibold">{replica.name}</h2>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                    {replica.description || "No description yet."}
                  </p>
                </div>
                <Badge
                  variant={replica.status === "ready" ? "default" : "secondary"}
                  className="ml-auto shrink-0"
                >
                  {replica.status}
                </Badge>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                {replica.message_count.toLocaleString()} messages learned
                {replica.source_filename ? ` · ${replica.source_filename}` : ""}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button asChild size="sm">
                  <Link to="/chat" search={{ replica: replica.id }}>
                    <MessageCircle className="size-4" aria-hidden />
                    Chat
                  </Link>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSelected(selected === replica.id ? null : replica.id)}
                >
                  {selected === replica.id ? "Hide details" : "Style & people"}
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="ghost">
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete {replica.name}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This permanently removes their messages, memories, uploaded files and chat
                        history. It cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep</AlertDialogCancel>
                      <AlertDialogAction onClick={() => remove.mutate(replica.id)}>
                        Delete permanently
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>

              {selected === replica.id && (
                <ReplicaDetails replicaId={replica.id} initialDescription={replica.description} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReplicaDetails({
  replicaId,
  initialDescription,
}: {
  replicaId: string;
  initialDescription: string | null;
}) {
  const queryClient = useQueryClient();
  const [instructions, setInstructions] = useState("");
  const [description, setDescription] = useState(initialDescription ?? "");

  const style = useQuery({
    queryKey: ["style", replicaId],
    queryFn: async () => {
      const profile = await getStyleProfile(replicaId);
      setInstructions((profile?.["custom_instructions"] as string | null) ?? "");
      return profile;
    },
  });
  const participants = useQuery({
    queryKey: ["participants", replicaId],
    queryFn: () => listParticipants(replicaId),
  });

  const saveStyle = useMutation({
    mutationFn: () => saveCustomInstructions(replicaId, instructions),
    onSuccess: () => toast.success("Instructions saved."),
    onError: (error: Error) => toast.error(error.message),
  });
  const saveDescription = useMutation({
    mutationFn: () => updateReplica(replicaId, { description }),
    onSuccess: () => {
      toast.success("Description saved.");
      void queryClient.invalidateQueries({ queryKey: ["replicas"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) => setParticipantRole(id, role),
    onSuccess: () => {
      toast.success("Role updated.");
      void queryClient.invalidateQueries({ queryKey: ["participants", replicaId] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const language = style.data?.["language_profile"] as { primary?: string } | undefined;
  const emoji = style.data?.["emoji_profile"] as { top?: string[]; per_message?: number } | undefined;
  const length = style.data?.["response_length_profile"] as { average_words?: number } | undefined;
  const humor = style.data?.["humor_profile"] as { level?: string } | undefined;

  return (
    <div className="mt-5 space-y-4 border-t border-border pt-4">
      <div className="space-y-1.5">
        <Label htmlFor={`desc-${replicaId}`}>Description</Label>
        <Textarea
          id={`desc-${replicaId}`}
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <Button size="sm" variant="outline" onClick={() => saveDescription.mutate()}>
          Save description
        </Button>
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Detected style
        </p>
        {style.isLoading ? (
          <Loader2 className="mt-2 size-4 animate-spin" aria-label="Loading" />
        ) : style.data ? (
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <Badge variant="secondary">Language: {language?.primary ?? "—"}</Badge>
            <Badge variant="secondary">
              Emoji: {emoji?.per_message?.toFixed(2) ?? "0"} / message
            </Badge>
            <Badge variant="secondary">
              Avg length: {Math.round(length?.average_words ?? 0)} words
            </Badge>
            <Badge variant="secondary">Humour: {humor?.level ?? "—"}</Badge>
            {(emoji?.top ?? []).slice(0, 5).map((symbol) => (
              <Badge key={symbol} variant="outline">
                {symbol}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            No style analysis yet — import a conversation.
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`instructions-${replicaId}`}>Custom instructions</Label>
        <Textarea
          id={`instructions-${replicaId}`}
          rows={3}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder="Always call me by my nickname. Never talk about work."
        />
        <Button size="sm" variant="outline" onClick={() => saveStyle.mutate()}>
          Save instructions
        </Button>
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          People in this conversation
        </p>
        <ul className="mt-2 space-y-2">
          {(participants.data ?? []).map((participant) => (
            <li key={participant.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm">
                {participant.display_name}
                <span className="ml-2 text-xs text-muted-foreground">
                  {participant.message_count.toLocaleString()} msgs
                </span>
              </span>
              <Select
                value={participant.role}
                onValueChange={(role) => changeRole.mutate({ id: participant.id, role })}
              >
                <SelectTrigger className="w-32" aria-label="Role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="replica">Replica</SelectItem>
                  <SelectItem value="me">Me</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </li>
          ))}
          {!participants.data?.length && (
            <li className="text-sm text-muted-foreground">No participants detected yet.</li>
          )}
        </ul>
      </div>
    </div>
  );
}
