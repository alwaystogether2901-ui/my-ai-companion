import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { FileUp, Loader2, RotateCcw } from "lucide-react";

import { AuthGate } from "@/components/auth-gate";
import { assertAuthorized, useAuth } from "@/lib/auth";
import { listJobs, listReplicas, listSourceFiles } from "@/lib/data";
import { listParticipants } from "@/lib/data";
import { toDisplayMessage } from "@/lib/errors";
import {
  ALLOWED_IMPORT_EXTENSIONS,
  finalizeParticipantRoles,
  importConversationFile,
  retryImport,
  validateImportFile,
  type ImportProgress,
} from "@/lib/processing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/upload")({
  head: () => ({
    meta: [
      { title: "Import a conversation — Always Together" },
      {
        name: "description",
        content: "Upload WhatsApp, JSON, CSV or ZIP chat exports to build a private AI replica.",
      },
      { property: "og:title", content: "Import a conversation — Always Together" },
      {
        property: "og:description",
        content: "Upload WhatsApp, JSON, CSV or ZIP chat exports to build a private AI replica.",
      },
    ],
  }),
  component: () => (
    <AuthGate>
      <UploadPage />
    </AuthGate>
  ),
});

function UploadPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [replicaName, setReplicaName] = useState("");
  const [targetReplica, setTargetReplica] = useState<string>("new");
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [selectReplicaId, setSelectReplicaId] = useState<string | null>(null);
  const [meId, setMeId] = useState<string>("");
  const [replicaPersonId, setReplicaPersonId] = useState<string>("");
  const [dragging, setDragging] = useState(false);

  const replicas = useQuery({ queryKey: ["replicas"], queryFn: listReplicas });
  const jobs = useQuery({
    queryKey: ["jobs"],
    queryFn: () => listJobs(),
    refetchInterval: progress ? 2000 : false,
  });
  const sourceFiles = useQuery({ queryKey: ["source-files"], queryFn: () => listSourceFiles() });

  const importMutation = useMutation({
    mutationFn: async () => {
      const ownerId = assertAuthorized(auth);
      if (!file) throw new Error("Choose a file to import.");
      return importConversationFile({
        ownerId,
        file,
        ...(targetReplica !== "new" ? { replicaId: targetReplica } : {}),
        ...(replicaName.trim() ? { replicaName: replicaName.trim() } : {}),
        onProgress: setProgress,
      });
    },
    onSuccess: (result) => {
      setFile(null);
      setReplicaName("");
      setProgress(null);
      if (inputRef.current) inputRef.current.value = "";
      toast.success(
        `Imported ${result.messages.toLocaleString()} messages across ${result.conversations} conversation(s).`,
        { description: result.duplicate ? "Note: this file looked like a previous upload." : undefined },
      );
      void queryClient.invalidateQueries();
      setSelectReplicaId(result.replicaId);
      setMeId("");
      setReplicaPersonId("");
    },
    onError: (error: unknown) => {
      setProgress(null);
      toast.error(toDisplayMessage(error));
    },
  });

  const retry = useMutation({
    mutationFn: async (sourceFileId: string) => {
      const ownerId = assertAuthorized(auth);
      return retryImport({ ownerId, sourceFileId, onProgress: setProgress });
    },
    onSuccess: () => {
      setProgress(null);
      toast.success("Reprocessed successfully.");
      void queryClient.invalidateQueries();
    },
    onError: (error: unknown) => {
      setProgress(null);
      toast.error(toDisplayMessage(error));
    },
  });

  const participants = useQuery({
    queryKey: ["participants", selectReplicaId],
    queryFn: () => listParticipants(selectReplicaId!),
    enabled: Boolean(selectReplicaId),
  });

  const finalize = useMutation({
    mutationFn: async () => {
      const ownerId = assertAuthorized(auth);
      if (!selectReplicaId) throw new Error("No imported replica selected.");
      if (!meId || !replicaPersonId) throw new Error("Choose both ME and the REPLICA.");
      return finalizeParticipantRoles({
        ownerId,
        replicaId: selectReplicaId,
        meParticipantId: meId,
        replicaParticipantId: replicaPersonId,
      });
    },
    onSuccess: (result) => {
      const replicaId = selectReplicaId!;
      setSelectReplicaId(null);
      toast.success(
        `Replica built from ${result.replicaName} (${result.replicaMessages.toLocaleString()} of their messages analyzed).`,
      );
      void queryClient.invalidateQueries();
      navigate({ to: "/chat", search: { replica: replicaId } });
    },
    onError: (error: unknown) => toast.error(toDisplayMessage(error)),
  });

  function chooseFile(next: File | null) {
    if (!next) {
      setFile(null);
      return;
    }
    const error = validateImportFile(next);
    if (error) {
      toast.error(error);
      return;
    }
    setFile(next);
    if (!replicaName) setReplicaName(next.name.replace(/\.[^.]+$/, ""));
  }

  const busy = importMutation.isPending || retry.isPending;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-2xl font-semibold">Import a conversation</h1>
        <p className="text-sm text-muted-foreground">
          WhatsApp exports, JSON archives, CSV logs or a ZIP containing any of them.
        </p>
      </header>

      <section
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          chooseFile(event.dataTransfer.files?.[0] ?? null);
        }}
        className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
          dragging ? "border-primary bg-primary/5" : "border-border"
        }`}
      >
        <FileUp className="mx-auto size-8 text-muted-foreground" aria-hidden />
        <p className="mt-3 font-medium">{file ? file.name : "Drop your export here"}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {file
            ? `${(file.size / 1024 / 1024).toFixed(2)} MB`
            : `${ALLOWED_IMPORT_EXTENSIONS.join(", ")} · up to 200 MB`}
        </p>
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          accept={ALLOWED_IMPORT_EXTENSIONS.join(",")}
          onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
        />
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          Choose file
        </Button>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="target">Add to</Label>
          <Select value={targetReplica} onValueChange={setTargetReplica}>
            <SelectTrigger id="target">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="new">Create a new replica</SelectItem>
              {(replicas.data ?? []).map((replica) => (
                <SelectItem key={replica.id} value={replica.id}>
                  {replica.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {targetReplica === "new" && (
          <div className="space-y-1.5">
            <Label htmlFor="new-name">Replica name</Label>
            <Input
              id="new-name"
              value={replicaName}
              onChange={(event) => setReplicaName(event.target.value)}
              placeholder="Mum"
            />
          </div>
        )}
      </section>

      {selectReplicaId && (
        <section className="space-y-4 rounded-xl border border-primary/40 bg-primary/5 p-4">
          <div>
            <h2 className="font-display text-lg font-semibold">Who is who?</h2>
            <p className="text-sm text-muted-foreground">
              We detected these people in the export. Tell us which one is you and which one the
              replica should become — only the selected person&apos;s messages are analyzed.
            </p>
          </div>
          {participants.isLoading ? (
            <Loader2 className="size-5 animate-spin text-primary" aria-label="Loading" />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="me-select">Which person are YOU?</Label>
                <Select value={meId} onValueChange={setMeId}>
                  <SelectTrigger id="me-select">
                    <SelectValue placeholder="Select yourself" />
                  </SelectTrigger>
                  <SelectContent>
                    {(participants.data ?? []).map((person) => (
                      <SelectItem key={person.id} value={person.id}>
                        {person.display_name} · {person.message_count.toLocaleString()} msgs
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="replica-select">Who should become the REPLICA?</Label>
                <Select value={replicaPersonId} onValueChange={setReplicaPersonId}>
                  <SelectTrigger id="replica-select">
                    <SelectValue placeholder="Select the replica" />
                  </SelectTrigger>
                  <SelectContent>
                    {(participants.data ?? [])
                      .filter((person) => person.id !== meId)
                      .map((person) => (
                        <SelectItem key={person.id} value={person.id}>
                          {person.display_name} · {person.message_count.toLocaleString()} msgs
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          <Button
            onClick={() => finalize.mutate()}
            disabled={!meId || !replicaPersonId || finalize.isPending}
            className="w-full sm:w-auto"
          >
            {finalize.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
            Build the replica
          </Button>
        </section>
      )}

      {progress && (
        <section className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm font-medium">
            {progress.stage} — {progress.step}
          </p>
          <Progress value={progress.progress} className="mt-3" />
          <p className="mt-2 text-xs text-muted-foreground">
            {Math.round(progress.progress)}% — keep this tab open until it finishes.
          </p>
        </section>
      )}

      <Button
        onClick={() => importMutation.mutate()}
        disabled={!file || busy}
        className="w-full sm:w-auto"
      >
        {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
        Start import
      </Button>

      <section>
        <h2 className="font-display text-lg font-semibold">Import history</h2>
        {jobs.isLoading ? (
          <Loader2 className="mt-3 size-5 animate-spin text-primary" aria-label="Loading" />
        ) : !jobs.data?.length ? (
          <p className="mt-2 text-sm text-muted-foreground">Nothing imported yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {jobs.data.map((job) => {
              const source = (sourceFiles.data ?? []).find(
                (candidate) => candidate.id === job.source_file_id,
              );
              return (
                <li key={job.id} className="flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {source?.original_filename ??
                        String((job.metadata as { filename?: string }).filename ?? job.job_type)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(job.created_at).toLocaleString()} ·{" "}
                      {job.processed_items.toLocaleString()}/{job.total_items.toLocaleString()}{" "}
                      messages
                      {job.error_message ? ` · ${job.error_message}` : ""}
                    </p>
                  </div>
                  <Badge
                    variant={
                      job.status === "completed"
                        ? "default"
                        : job.status === "failed"
                          ? "destructive"
                          : "secondary"
                    }
                  >
                    {job.status}
                  </Badge>
                  {job.status === "failed" && source && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => retry.mutate(source.id)}
                      disabled={busy}
                    >
                      <RotateCcw className="size-4" aria-hidden />
                      Retry
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
