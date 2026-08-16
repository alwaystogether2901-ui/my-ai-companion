import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ImageIcon, Loader2, Trash2, Upload } from "lucide-react";

import { AuthGate } from "@/components/auth-gate";
import { assertAuthorized, useAuth } from "@/lib/auth";
import {
  BUCKET_MEMORIES,
  createMemory,
  deleteMemory,
  listMemories,
  listReplicas,
  signedUrl,
  type MemoryItem,
} from "@/lib/data";
import { getSupabase, explainSupabaseError } from "@/lib/supabase";
import { compressImage, sanitizeFileName, MAX_MEDIA_BYTES } from "@/lib/processing";
import { guessMediaType } from "@/lib/parsers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/memories")({
  head: () => ({
    meta: [
      { title: "Memories — Always Together" },
      {
        name: "description",
        content: "Store photos, voice notes and written memories that shape your replicas.",
      },
      { property: "og:title", content: "Memories — Always Together" },
      {
        property: "og:description",
        content: "Store photos, voice notes and written memories that shape your replicas.",
      },
    ],
  }),
  component: () => (
    <AuthGate>
      <MemoriesPage />
    </AuthGate>
  ),
});

function MemoriesPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [replicaFilter, setReplicaFilter] = useState("all");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [search, setSearch] = useState("");

  const replicas = useQuery({ queryKey: ["replicas"], queryFn: listReplicas });
  const memories = useQuery({
    queryKey: ["memories", replicaFilter],
    queryFn: () => listMemories(replicaFilter === "all" ? undefined : replicaFilter),
  });

  const add = useMutation({
    mutationFn: async () => {
      const ownerId = assertAuthorized(auth);
      if (!title.trim() && !file) throw new Error("Add a title or a file.");
      let storagePath: string | null = null;
      let mediaType = "text";
      if (file) {
        if (file.size > MAX_MEDIA_BYTES) throw new Error("Files must be under 50 MB.");
        const prepared = await compressImage(file);
        storagePath = `${ownerId}/${Date.now()}-${sanitizeFileName(prepared.name)}`;
        const supabase = await getSupabase();
        const { error } = await supabase.storage
          .from(BUCKET_MEMORIES)
          .upload(storagePath, prepared, {
            contentType: prepared.type || "application/octet-stream",
          });
        if (error) throw new Error(explainSupabaseError(error));
        mediaType = guessMediaType(prepared.name);
      }
      return createMemory(ownerId, {
        replica_id: replicaFilter === "all" ? null : replicaFilter,
        title: title.trim() || file?.name || "Memory",
        description: description.trim() || null,
        media_type: mediaType,
        bucket_name: storagePath ? BUCKET_MEMORIES : null,
        storage_path: storagePath,
        metadata: {},
      });
    },
    onSuccess: () => {
      setTitle("");
      setDescription("");
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      toast.success("Memory saved.");
      void queryClient.invalidateQueries({ queryKey: ["memories"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (memory: MemoryItem) => deleteMemory(memory),
    onSuccess: () => {
      toast.success("Memory deleted.");
      void queryClient.invalidateQueries({ queryKey: ["memories"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const filtered = (memories.data ?? []).filter((memory) => {
    if (!search.trim()) return true;
    const haystack = `${memory.title ?? ""} ${memory.description ?? ""}`.toLowerCase();
    return haystack.includes(search.trim().toLowerCase());
  });

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-2xl font-semibold">Memories</h1>
        <p className="text-sm text-muted-foreground">
          Photos, voice notes and moments your replicas can draw on.
        </p>
      </header>

      <section className="grid gap-4 rounded-xl border border-border bg-card p-5 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="memory-replica">Replica</Label>
          <Select value={replicaFilter} onValueChange={setReplicaFilter}>
            <SelectTrigger id="memory-replica">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Not linked / all</SelectItem>
              {(replicas.data ?? []).map((replica) => (
                <SelectItem key={replica.id} value={replica.id}>
                  {replica.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="memory-title">Title</Label>
          <Input
            id="memory-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="The summer we drove to the coast"
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="memory-description">What happened?</Label>
          <Textarea
            id="memory-description"
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <input
            ref={inputRef}
            type="file"
            className="sr-only"
            accept="image/*,video/*,audio/*,.pdf,.txt"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <Button variant="outline" onClick={() => inputRef.current?.click()}>
            <Upload className="size-4" aria-hidden />
            {file ? file.name : "Attach a file"}
          </Button>
          <Button onClick={() => add.mutate()} disabled={add.isPending}>
            {add.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
            Save memory
          </Button>
        </div>
      </section>

      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search memories…"
        aria-label="Search memories"
      />

      {memories.isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="size-6 animate-spin text-primary" aria-label="Loading" />
        </div>
      ) : !filtered.length ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <ImageIcon className="mx-auto size-8 text-muted-foreground" aria-hidden />
          <p className="mt-3 font-medium">No memories here yet</p>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((memory) => (
            <li key={memory.id} className="overflow-hidden rounded-xl border border-border bg-card">
              <MemoryPreview memory={memory} />
              <div className="space-y-2 p-4">
                <div className="flex items-start gap-2">
                  <p className="min-w-0 flex-1 truncate text-sm font-medium">
                    {memory.title ?? "Untitled"}
                  </p>
                  <Badge variant="secondary" className="shrink-0">
                    {memory.media_type ?? "text"}
                  </Badge>
                </div>
                {memory.description && (
                  <p className="line-clamp-3 text-xs text-muted-foreground">{memory.description}</p>
                )}
                <div className="flex items-center gap-2 pt-1">
                  <span className="text-[11px] text-muted-foreground">
                    {new Date(memory.created_at).toLocaleDateString()}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => remove.mutate(memory)}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MemoryPreview({ memory }: { memory: MemoryItem }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (memory.bucket_name && memory.storage_path) {
      void signedUrl(memory.bucket_name, memory.storage_path).then((value) => {
        if (active) setUrl(value);
      });
    }
    return () => {
      active = false;
    };
  }, [memory.bucket_name, memory.storage_path]);

  if (!memory.storage_path) return null;
  if (memory.media_type === "image") {
    return url ? (
      <img
        src={url}
        alt={memory.title ?? "Memory"}
        loading="lazy"
        className="aspect-video w-full object-cover"
      />
    ) : (
      <div className="aspect-video w-full animate-pulse bg-muted" />
    );
  }
  if (memory.media_type === "audio" && url) {
    return <audio controls src={url} className="w-full px-4 pt-4" />;
  }
  if (memory.media_type === "video" && url) {
    return <video controls src={url} className="aspect-video w-full bg-black" />;
  }
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="block px-4 pt-4 text-xs text-primary underline-offset-4 hover:underline"
    >
      Open file
    </a>
  ) : null;
}
