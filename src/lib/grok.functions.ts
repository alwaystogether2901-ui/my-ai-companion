import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const generateSchema = z.object({
  idToken: z.string().min(20),
  replicaId: z.string().uuid(),
  sessionId: z.string().uuid(),
  message: z.string().min(1).max(4000),
  mediaPath: z.string().max(500).optional(),
  replyToMessageId: z.string().uuid().optional(),
});

export type GenerateReplyResult = {
  ok: boolean;
  reply: string;
  messageId: string | null;
  generatedResponseId: string | null;
  usedMemories: number;
  error?: string;
  errorKind?:
    | "auth"
    | "ownership"
    | "grok"
    | "timeout"
    | "rate_limit"
    | "database"
    | "unknown";
};

/**
 * Secure AI generation.
 *
 * Firebase authentication
 *        ↓
 * Firebase ID token verification
 *        ↓
 * Supabase RLS
 *        ↓
 * Load replica + memories + style + history
 *        ↓
 * OpenRouter
 *        ↓
 * Save generated response
 *        ↓
 * Save chat message
 *
 * OPENROUTER_API_KEY is SERVER-SIDE ONLY.
 */
export const generateReply = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => generateSchema.parse(input))
  .handler(async ({ data }): Promise<GenerateReplyResult> => {
    const { verifyFirebaseIdToken, createUserScopedSupabase } =
      await import("./firebase-verify.server");

    /* ================================================================
       1. VERIFY FIREBASE USER
    ================================================================= */

    let uid: string;

    try {
      uid = (await verifyFirebaseIdToken(data.idToken)).uid;
    } catch (error) {
      return {
        ok: false,
        reply: "",
        messageId: null,
        generatedResponseId: null,
        usedMemories: 0,
        errorKind: "auth",
        error:
          error instanceof Error
            ? error.message
            : "Authentication failed",
      };
    }

    /* ================================================================
       2. CREATE USER-SCOPED SUPABASE CLIENT
    ================================================================= */

    const supabase = await createUserScopedSupabase(data.idToken);

    /* ================================================================
       3. VERIFY REPLICA OWNERSHIP
    ================================================================= */

    const { data: replica, error: replicaError } = await supabase
      .from("replicas")
      .select("id, name, description, owner_id")
      .eq("id", data.replicaId)
      .maybeSingle();

    if (replicaError) {
      return {
        ok: false,
        reply: "",
        messageId: null,
        generatedResponseId: null,
        usedMemories: 0,
        errorKind: "database",
        error: replicaError.message,
      };
    }

    if (!replica || replica.owner_id !== uid) {
      return {
        ok: false,
        reply: "",
        messageId: null,
        generatedResponseId: null,
        usedMemories: 0,
        errorKind: "ownership",
        error: "This replica does not belong to you.",
      };
    }

    /* ================================================================
       4. LOAD STYLE + PARTICIPANTS
    ================================================================= */

    const [{ data: style }, { data: participants }] =
      await Promise.all([
        supabase
          .from("replica_style_profiles")
          .select("*")
          .eq("replica_id", data.replicaId)
          .maybeSingle(),

        supabase
          .from("replica_participants")
          .select("display_name, role, message_count")
          .eq("replica_id", data.replicaId)
          .order("message_count", { ascending: false })
          .limit(6),
      ]);

    /* ================================================================
       5. FIND RELEVANT MEMORIES
    ================================================================= */

    const keywords = data.message
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3)
      .slice(0, 4);

    const memoryHits: {
      title: string | null;
      description: string | null;
    }[] = [];

    for (const keyword of keywords) {
      const { data: rows } = await supabase
        .from("memory_items")
        .select("title, description")
        .eq("replica_id", data.replicaId)
        .ilike("description", `%${keyword}%`)
        .limit(3);

      if (rows) {
        memoryHits.push(...rows);
      }
    }

    /* ================================================================
       6. FALLBACK TO RECENT MEMORIES
    ================================================================= */

    if (memoryHits.length === 0) {
      const { data: rows } = await supabase
        .from("memory_items")
        .select("title, description")
        .eq("replica_id", data.replicaId)
        .order("created_at", { ascending: false })
        .limit(6);

      if (rows) {
        memoryHits.push(...rows);
      }
    }

    /* ================================================================
       7. LOAD AUTHENTIC REPLICA EXAMPLES
    ================================================================= */

    const { data: sourceExamples } = await supabase
      .from("messages")
      .select("sender_name, sender_role, message_text")
      .eq("replica_id", data.replicaId)
      .eq("sender_role", "replica")
      .not("message_text", "is", null)
      .limit(40);

    /* ================================================================
       8. LOAD CHAT HISTORY
    ================================================================= */

    const { data: history } = await supabase
      .from("chat_session_messages")
      .select("sender_role, message_text")
      .eq("session_id", data.sessionId)
      .order("created_at", { ascending: false })
      .limit(16);

    /* ================================================================
       9. DETERMINE REPLICA NAME
    ================================================================= */

    const replicaName =
      (participants ?? []).find(
        (p) => p.role === "replica",
      )?.display_name ?? replica.name;

    /* ================================================================
       10. BUILD STYLE SUMMARY
    ================================================================= */

    const styleSummary = style
      ? JSON.stringify(
          {
            language: style.language_profile,
            emoji: style.emoji_profile,
            punctuation: style.punctuation_profile,
            length: style.response_length_profile,
            greetings: style.greeting_profile,
            humor: style.humor_profile,
            vocabulary: (
              style.vocabulary_profile as {
                signature_phrases?: unknown;
              }
            )?.signature_phrases,
          },
          null,
          0,
        ).slice(0, 4000)
      : "No style profile available yet.";

    /* ================================================================
       11. BUILD SYSTEM PROMPT
    ================================================================= */

    const systemPrompt = [
      `You are a faithful conversational replica of ${replicaName}.`,

      replica.description
        ? `Context about them: ${replica.description}`
        : "",

      `Reproduce their voice naturally and consistently.`,

      `Match their wording, rhythm, message length, punctuation habits, emoji use, vocabulary, tone, and language mix.`,

      `Use the authentic examples as strong evidence of how they communicate.`,

      `Use memories when they are relevant to the user's message.`,

      `Do not invent personal facts when the available memories do not support them.`,

      `Never mention being an AI, language model, OpenRouter, API, or replica.`,

      `Never explain your reasoning.`,

      `Stay in character.`,

      `Measured style profile: ${styleSummary}`,

      (style?.custom_instructions as string | null)
        ? `Owner instructions: ${style.custom_instructions}`
        : "",

      memoryHits.length
        ? `Relevant memories:
${memoryHits
  .slice(0, 8)
  .map(
    (m) =>
      `- ${m.title ?? "memory"}: ${(m.description ?? "").slice(
        0,
        400,
      )}`,
  )
  .join("\n")}`
        : "",

      sourceExamples?.length
        ? `Authentic examples of how they write:
${sourceExamples
  .slice(0, 25)
  .map(
    (m) =>
      `- ${(m.message_text ?? "").slice(0, 200)}`,
  )
  .join("\n")}`
        : "",

      data.mediaPath
        ? "The user attached a media file to this message."
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    /* ================================================================
       12. BUILD CHAT MESSAGES
    ================================================================= */

    const messages = [
      {
        role: "system",
        content: systemPrompt,
      },

      ...(history ?? [])
        .slice()
        .reverse()
        .map((row) => ({
          role:
            row.sender_role === "replica"
              ? "assistant"
              : "user",
          content: row.message_text ?? "",
        }))
        .filter((row) => row.content),

      {
        role: "user",
        content: data.message,
      },
    ];

    /* ================================================================
       13. OPENROUTER API KEY
    ================================================================= */

    const apiKey = process.env["OPENROUTER_API_KEY"];

    if (!apiKey) {
      return {
        ok: false,
        reply: "",
        messageId: null,
        generatedResponseId: null,
        usedMemories: memoryHits.length,
        errorKind: "grok",
        error:
          "The AI backend is not configured (missing OPENROUTER_API_KEY).",
      };
    }

    /* ================================================================
       14. CALL OPENROUTER
    ================================================================= */

    let reply = "";

    let openRouterMeta: Record<string, unknown> = {};

    const attemptLimit = 2;

    for (
      let attempt = 1;
      attempt <= attemptLimit;
      attempt += 1
    ) {
      const controller = new AbortController();

      const timeout = setTimeout(() => {
        controller.abort();
      }, 45_000);

      try {
        const response = await fetch(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json",

              Authorization: `Bearer ${apiKey}`,

              "HTTP-Referer":
                "https://always-together.vercel.app",

              "X-Title": "Always Together",
            },

            body: JSON.stringify({
              model: "openrouter/free",

              messages,

              temperature: 0.85,

              max_tokens: 700,
            }),

            signal: controller.signal,
          },
        );

        clearTimeout(timeout);

        /* ------------------------------------------------------------
           RATE LIMIT
        ------------------------------------------------------------ */

        if (response.status === 429) {
          if (attempt < attemptLimit) {
            await new Promise((resolve) =>
              setTimeout(resolve, 1500),
            );

            continue;
          }

          return {
            ok: false,
            reply: "",
            messageId: null,
            generatedResponseId: null,
            usedMemories: memoryHits.length,
            errorKind: "rate_limit",
            error:
              "OpenRouter is rate limiting requests right now. Try again in a moment.",
          };
        }

        /* ------------------------------------------------------------
           OTHER API ERRORS
        ------------------------------------------------------------ */

        if (!response.ok) {
          const body = await response.text();

          console.error(
            `[openrouter] ${response.status}: ${body}`,
          );

          if (
            attempt < attemptLimit &&
            response.status >= 500
          ) {
            continue;
          }

          let readableError =
            `The AI service returned an error (${response.status}).`;

          try {
            const parsed = JSON.parse(body) as {
              error?: {
                message?: string;
              };
            };

            if (parsed?.error?.message) {
              readableError =
                `OpenRouter: ${parsed.error.message}`;
            }
          } catch {
            // Keep generic error.
          }

          return {
            ok: false,
            reply: "",
            messageId: null,
            generatedResponseId: null,
            usedMemories: memoryHits.length,
            errorKind: "grok",
            error: readableError,
          };
        }

        /* ------------------------------------------------------------
           PARSE OPENROUTER RESPONSE
        ------------------------------------------------------------ */

        const payload = (await response.json()) as {
          choices?: {
            message?: {
              content?: string;
            };
          }[];

          usage?: Record<string, unknown>;

          model?: string;

          id?: string;
        };

        reply =
          payload.choices?.[0]?.message?.content?.trim() ?? "";

        openRouterMeta = {
          provider: "openrouter",
          model:
            payload.model ?? "openrouter/free",
          request_id: payload.id ?? null,
          usage: payload.usage ?? {},
          attempt,
        };

        /* ------------------------------------------------------------
           EMPTY RESPONSE
        ------------------------------------------------------------ */

        if (!reply) {
          return {
            ok: false,
            reply: "",
            messageId: null,
            generatedResponseId: null,
            usedMemories: memoryHits.length,
            errorKind: "grok",
            error:
              "The AI service returned an empty response.",
          };
        }

        break;
      } catch (error) {
        clearTimeout(timeout);

        const aborted =
          error instanceof Error &&
          error.name === "AbortError";

        if (attempt < attemptLimit) {
          continue;
        }

        return {
          ok: false,
          reply: "",
          messageId: null,
          generatedResponseId: null,
          usedMemories: memoryHits.length,
          errorKind: aborted
            ? "timeout"
            : "unknown",

          error: aborted
            ? "The AI service took too long to respond. Try again."
            : "Could not reach OpenRouter. Check your connection and retry.",
        };
      }
    }

    /* ================================================================
       15. SAVE GENERATED RESPONSE
    ================================================================= */

    const {
      data: generated,
      error: generatedError,
    } = await supabase
      .from("generated_responses")
      .insert({
        owner_id: uid,

        replica_id: data.replicaId,

        user_message: data.message,

        generated_response: reply,

        retrieval_context: {
          memories: memoryHits
            .slice(0, 8)
            .map((m) => m.title),

          examples:
            sourceExamples?.length ?? 0,

          history:
            history?.length ?? 0,
        },

        generation_metadata: openRouterMeta,
      })
      .select("id")
      .single();

    if (generatedError) {
      return {
        ok: false,
        reply,
        messageId: null,
        generatedResponseId: null,
        usedMemories: memoryHits.length,
        errorKind: "database",
        error: generatedError.message,
      };
    }

    /* ================================================================
       16. SAVE REPLICA CHAT MESSAGE
    ================================================================= */

    const {
      data: stored,
      error: storeError,
    } = await supabase
      .from("chat_session_messages")
      .insert({
        owner_id: uid,

        session_id: data.sessionId,

        sender_role: "replica",

        message_text: reply,

        generated_response_id: generated!.id,

        reply_to_message_id:
          data.replyToMessageId ?? null,
      })
      .select("id")
      .single();

    if (storeError) {
      return {
        ok: false,
        reply,
        messageId: null,
        generatedResponseId:
          generated!.id as string,
        usedMemories: memoryHits.length,
        errorKind: "database",
        error: storeError.message,
      };
    }

    /* ================================================================
       17. UPDATE CHAT SESSION
    ================================================================= */

    await supabase
      .from("chat_sessions")
      .update({
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.sessionId);

    /* ================================================================
       18. SUCCESS
    ================================================================= */

    return {
      ok: true,

      reply,

      messageId: stored!.id as string,

      generatedResponseId:
        generated!.id as string,

      usedMemories: memoryHits.length,
    };
  });
