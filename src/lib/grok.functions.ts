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
 * Always Together — faithful replica generation engine.
 *
 * Existing architecture preserved:
 *
 * Firebase authentication
 *        ↓
 * Supabase RLS / ownership
 *        ↓
 * Existing replica + style data
 *        ↓
 * Existing retrieval RPCs:
 *   - search_similar_exchanges
 *   - search_replica_messages
 *   - search_memories
 *        ↓
 * Conversation context
 *        ↓
 * Evidence-first response generation
 *        ↓
 * Strip internal reasoning / formatting
 *        ↓
 * Idempotent save
 *        ↓
 * Final answer only
 *
 * No new database functions are required here.
 *
 * OPENROUTER_API_KEY is SERVER-SIDE ONLY.
 */

/* =====================================================================
   TYPES
===================================================================== */

type RetrievalExchange = {
  prompt_text?: string | null;
  prompt_sender?: string | null;
  reply_text?: string | null;
  similarity?: number | null;
  sent_at?: string | null;
};

type RetrievedMessage = {
  message_text?: string | null;
  sender_name?: string | null;
  sender_role?: string | null;
  sent_at?: string | null;
};

type RetrievedMemory = {
  id?: string | null;
  title?: string | null;
  description?: string | null;
  media_type?: string | null;
  storage_path?: string | null;
};

type ChatHistoryRow = {
  sender_role?: string | null;
  message_text?: string | null;
};

/* =====================================================================
   HELPERS
===================================================================== */

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Removes model reasoning / hidden-thought style wrappers if a provider
 * happens to return them despite the API-level reasoning restriction.
 *
 * This is intentionally conservative:
 * - Removes <think>...</think>
 * - Removes common "analysis:" prefixes
 * - Removes fenced reasoning wrappers
 * - Keeps the actual final conversational answer
 */
function sanitizeFinalReply(raw: string): string {
  let text = cleanText(raw);

  if (!text) return "";

  // Remove explicit think blocks.
  text = text.replace(
    /<think>[\s\S]*?<\/think>/gi,
    "",
  );

  // Remove other common reasoning wrappers.
  text = text.replace(
    /<analysis>[\s\S]*?<\/analysis>/gi,
    "",
  );

  text = text.replace(
    /<reasoning>[\s\S]*?<\/reasoning>/gi,
    "",
  );

  // Remove accidental fenced analysis blocks.
  text = text.replace(
    /```(?:analysis|reasoning|thinking)[\s\S]*?```/gi,
    "",
  );

  text = text.trim();

  // If the model starts with a reasoning label, remove the label only.
  text = text.replace(
    /^(?:analysis|reasoning|thinking|internal reasoning)\s*:\s*/i,
    "",
  );

  // Avoid returning obvious meta commentary.
  if (
    /^(?:as an ai|as a language model|i am an ai|i can't reveal my reasoning)/i.test(
      text,
    )
  ) {
    return "";
  }

  return text.trim();
}

/**
 * De-duplicates retrieved rows while preserving ranking order.
 */
function uniqueBy<T>(
  rows: T[],
  key: (row: T) => string,
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const row of rows) {
    const value = key(row);

    if (!value || seen.has(value)) continue;

    seen.add(value);
    result.push(row);
  }

  return result;
}

/**
 * Keep retrieval context bounded so a huge dataset never becomes a
 * huge prompt. The database performs the actual retrieval; this layer
 * selects the strongest evidence for the model.
 */
function clampText(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}…`
    : text;
}

/* =====================================================================
   SERVER FUNCTION
===================================================================== */

export const generateReply = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => generateSchema.parse(input))
  .handler(async ({ data }): Promise<GenerateReplyResult> => {
    const {
      verifyFirebaseIdToken,
      createUserScopedSupabase,
    } = await import("./firebase-verify.server");

    /* ================================================================
       1. FIREBASE AUTHENTICATION
    ================================================================= */

    let uid: string;

    try {
      uid = (
        await verifyFirebaseIdToken(data.idToken)
      ).uid;
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
       2. USER-SCOPED SUPABASE
    ================================================================= */

    const supabase =
      await createUserScopedSupabase(data.idToken);

    /* ================================================================
       3. VERIFY REPLICA OWNERSHIP
    ================================================================= */

    const {
      data: replica,
      error: replicaError,
    } = await supabase
      .from("replicas")
      .select(
        "id, name, description, owner_id",
      )
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

    if (
      !replica ||
      replica.owner_id !== uid
    ) {
      return {
        ok: false,
        reply: "",
        messageId: null,
        generatedResponseId: null,
        usedMemories: 0,
        errorKind: "ownership",
        error:
          "This replica does not belong to you.",
      };
    }

    /* ================================================================
       4. IDEMPOTENCY CHECK
       
       If the frontend retries the same user message, do not generate
       another replica response for the same reply_to_message_id.
    ================================================================= */

    if (data.replyToMessageId) {
      const {
        data: existingReply,
        error: existingReplyError,
      } = await supabase
        .from("chat_session_messages")
        .select(
          "id, message_text, generated_response_id",
        )
        .eq("session_id", data.sessionId)
        .eq(
          "reply_to_message_id",
          data.replyToMessageId,
        )
        .eq("sender_role", "replica")
        .limit(1)
        .maybeSingle();

      if (
        !existingReplyError &&
        existingReply?.message_text
      ) {
        return {
          ok: true,
          reply: existingReply.message_text,
          messageId:
            (existingReply.id as string) ?? null,
          generatedResponseId:
            (existingReply.generated_response_id as string) ??
            null,
          usedMemories: 0,
        };
      }
    }

    /* ================================================================
       5. LOAD STYLE + PARTICIPANTS + CHAT HISTORY
       
       These are independent reads, so load them in parallel.
    ================================================================= */

    const [
      styleResult,
      participantsResult,
      historyResult,
    ] = await Promise.all([
      supabase
        .from("replica_style_profiles")
        .select("*")
        .eq("replica_id", data.replicaId)
        .maybeSingle(),

      supabase
        .from("replica_participants")
        .select(
          "display_name, role, message_count",
        )
        .eq("replica_id", data.replicaId)
        .order("message_count", {
          ascending: false,
        })
        .limit(6),

      supabase
        .from("chat_session_messages")
        .select(
          "sender_role, message_text, created_at",
        )
        .eq("session_id", data.sessionId)
        .order("created_at", {
          ascending: false,
        })
        .limit(20),
    ]);

    const style = styleResult.data;
    const participants =
      participantsResult.data ?? [];

    const history =
      (historyResult.data ?? []) as ChatHistoryRow[];

    /* ================================================================
       6. IDENTIFY REPLICA
    ================================================================= */

    const replicaParticipant =
      participants.find(
        (p) => p.role === "replica",
      );

    const replicaName =
      replicaParticipant?.display_name ??
      replica.name;

    /* ================================================================
       7. BUILD CONTEXTUAL QUERY
       
       Do NOT search the entire database using only the latest words.
       Include a small amount of recent conversation context so the
       retrieval system understands what "that", "her", "him", etc.
       refer to.
    ================================================================= */

    const recentHistory = history
      .slice()
      .reverse()
      .filter(
        (row) =>
          cleanText(row.message_text),
      );

    const recentContext = recentHistory
      .slice(-6)
      .map(
        (row) =>
          `${row.sender_role === "replica"
            ? "REPLICA"
            : "USER"}: ${clampText(
            cleanText(row.message_text),
            500,
          )}`,
      )
      .join("\n");

    const retrievalQuery = [
      recentContext
        ? `Recent conversation:\n${recentContext}`
        : "",
      `Current user message:\n${data.message}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    /* ================================================================
       8. USE THE EXISTING DATABASE RETRIEVAL FUNCTIONS
       
       IMPORTANT:
       We are NOT creating new SQL functions.
       
       We use the functions already present in Supabase:
         - search_similar_exchanges
         - search_replica_messages
         - search_memories
       
       These are the actual dataset retrieval layer.
    ================================================================= */

    const [
      exchangeResult,
      replicaMessageResult,
      memoryResult,
    ] = await Promise.all([
      supabase.rpc(
        "search_similar_exchanges",
        {
          p_replica_id: data.replicaId,
          p_query: retrievalQuery,
          p_limit: 12,
        },
      ),

      supabase.rpc(
        "search_replica_messages",
        {
          p_replica_id: data.replicaId,
          p_query: data.message,
          p_limit: 12,
        },
      ),

      supabase.rpc(
        "search_memories",
        {
          p_replica_id: data.replicaId,
          p_query: data.message,
          p_limit: 10,
        },
      ),
    ]);

    const similarExchanges =
      ((exchangeResult.data ?? []) as RetrievalExchange[])
        .filter(
          (row) =>
            cleanText(row.prompt_text) &&
            cleanText(row.reply_text),
        );

    const replicaMessages =
      ((replicaMessageResult.data ??
        []) as RetrievedMessage[])
        .filter(
          (row) =>
            cleanText(row.message_text),
        );

    const memoryHits =
      ((memoryResult.data ?? []) as RetrievedMemory[])
        .filter(
          (row) =>
            cleanText(row.title) ||
            cleanText(row.description),
        );

    /* ================================================================
       9. AUTHENTIC DATASET EVIDENCE
       
       Similar exchanges are the highest-value evidence because they
       contain:
       
       USER SITUATION → ACTUAL REPLICA RESPONSE
       
       This is much stronger than giving the model random messages.
    ================================================================= */

    const uniqueExchanges =
      uniqueBy(
        similarExchanges,
        (row) =>
          `${cleanText(
            row.prompt_text,
          )}|||${cleanText(row.reply_text)}`,
      ).slice(0, 10);

    const uniqueReplicaMessages =
      uniqueBy(
        replicaMessages,
        (row) =>
          cleanText(row.message_text),
      ).slice(0, 12);

    /* ================================================================
       10. STYLE PROFILE
    ================================================================= */

    const styleSummary = style
      ? JSON.stringify(
          {
            language:
              style.language_profile,
            emoji:
              style.emoji_profile,
            punctuation:
              style.punctuation_profile,
            response_length:
              style.response_length_profile,
            greetings:
              style.greeting_profile,
            humor:
              style.humor_profile,
            vocabulary:
              (
                style.vocabulary_profile as {
                  signature_phrases?: unknown;
                }
              )?.signature_phrases,
          },
        ).slice(0, 5000)
      : "No measured style profile is available.";

    /* ================================================================
       11. BUILD EVIDENCE SECTIONS
    ================================================================= */

    const exchangeEvidence =
      uniqueExchanges.length
        ? uniqueExchanges
            .map(
              (row, index) =>
                `[EXCHANGE ${index + 1}]
USER/SITUATION: ${clampText(
                  cleanText(
                    row.prompt_text,
                  ),
                  600,
                )}
REPLICA'S ACTUAL RESPONSE: ${clampText(
                  cleanText(
                    row.reply_text,
                  ),
                  600,
                )}
SIMILARITY: ${
                  typeof row.similarity ===
                  "number"
                    ? row.similarity.toFixed(3)
                    : "unknown"
                }`,
            )
            .join("\n\n")
        : "No directly similar exchange was retrieved.";

    const messageEvidence =
      uniqueReplicaMessages.length
        ? uniqueReplicaMessages
            .map(
              (row, index) =>
                `${index + 1}. ${clampText(
                  cleanText(
                    row.message_text,
                  ),
                  350,
                )}`,
            )
            .join("\n")
        : "No additional authentic replica messages were retrieved.";

    const memoryEvidence =
      memoryHits.length
        ? memoryHits
            .slice(0, 8)
            .map(
              (memory, index) =>
                `${index + 1}. ${
                  cleanText(
                    memory.title,
                  ) || "Memory"
                }: ${clampText(
                  cleanText(
                    memory.description,
                  ),
                  500,
                )}`,
            )
            .join("\n")
        : "No relevant stored memories were retrieved.";

    /* ================================================================
       12. SYSTEM PROMPT
       
       This is deliberately evidence-first.
       
       The model is NOT told to simply "be creative".
       It is told to infer the response from authentic historical
       behavior and only adapt it when necessary.
    ================================================================= */

    const systemPrompt = `
You are the conversational replica of "${replicaName}".

Your job is NOT to be a generic helpful AI.

Your job is to reproduce the way this specific person would naturally
respond to the user in THIS exact conversational situation.

========================
CORE RULE — DATASET FIRST
========================

The supplied historical dataset is your primary behavioral evidence.

Before answering:

1. Understand what the user actually means.
2. Understand the current conversational situation.
3. Examine the retrieved historical exchanges.
4. Look for situations, intentions, emotions, questions, jokes, requests,
   topics and conversational patterns that are similar.
5. Determine how the replica actually responded in those situations.
6. Prefer authentic wording and response patterns from the dataset.
7. Adapt those patterns naturally to the current situation.
8. Do NOT randomly select an unrelated historical message.
9. Do NOT invent a generic AI response merely because it sounds plausible.

A historical response is especially valuable when it represents the same
TYPE OF SITUATION as the current message.

For example:
- A casual call/message should receive the kind of casual response
  found in similar casual exchanges.
- A playful request should receive the kind of playful response found
  in similar playful exchanges.
- A question about food should use the person's established way of
  talking about food.
- A question about sleep should use their established sleep-related
  language and tone.
- A teasing message should be answered with their established teasing
  style.
- A simple short message should normally receive a simple natural
  response, not an unrelated essay.

========================
AUTHENTIC WORDING
========================

When the dataset contains wording that naturally fits the current
situation, strongly prefer that wording.

Do not unnecessarily replace authentic wording with your own polished
AI wording.

Preserve the person's:
- vocabulary
- slang
- spelling habits
- Urdu/Hinglish/English mix
- sentence structure
- short forms
- repeated phrases
- teasing style
- humor
- affection
- punctuation
- capitalization habits
- emoji habits
- message length

Do NOT copy a historical response blindly when the situation is different.

Use the historical response as behavioral evidence and select/adapt the
closest authentic response pattern.

========================
CONTEXT MATTERS
========================

Never answer based only on the latest message if the recent conversation
changes its meaning.

Resolve references such as:
"that"
"him"
"her"
"there"
"haan"
"acha"
"sun"
"oye"
"piddi"
etc. using the conversation context.

The user's latest message and the recent conversation together define
the current situation.

========================
PERSONAL FACTS
========================

Only use personal facts when they are supported by the supplied memory,
replica description, conversation history, or dataset evidence.

Never fabricate:
- events
- relationships
- conversations
- locations
- schedules
- feelings
- family facts
- memories

========================
NATURAL CONVERSATION
========================

This is a real chat, not an interview.

Do not automatically explain things.

Do not automatically answer in complete formal sentences.

Do not add unnecessary context.

Do not repeat the user's question.

Do not produce generic assistant phrases.

Do not sound like ChatGPT.

Do not say:
"Certainly"
"Of course"
"As an AI"
"Based on the context"
"According to the dataset"
"According to the memories"
"I think"
"Here's my response"
or similar meta language unless the actual person's dataset naturally contains it.

If the authentic person normally replies with a few casual words,
reply with a few casual words.

If they normally joke, joke naturally.

If they normally tease, tease naturally.

If they normally use affectionate nicknames, use them naturally and
contextually rather than forcing them into every message.

========================
STYLE PROFILE
========================

Measured style profile:

${styleSummary}

========================
OWNER INSTRUCTIONS
========================

${
  cleanText(style?.custom_instructions)
    ? cleanText(
        style?.custom_instructions,
      )
    : "No additional owner instructions."
}

========================
AUTHENTIC SIMILAR EXCHANGES
========================

${exchangeEvidence}

========================
AUTHENTIC REPLICA MESSAGES
========================

${messageEvidence}

========================
RELEVANT MEMORIES
========================

${memoryEvidence}

========================
FINAL RESPONSE RULE
========================

Return ONLY the final message that the replica would send.

NEVER output:
- reasoning
- analysis
- chain of thought
- hidden thinking
- selection explanations
- dataset explanations
- retrieval explanations
- confidence scores
- labels
- "analysis:"
- "reasoning:"
- <think>
- <analysis>
- JSON
- markdown explaining the answer
- multiple candidate responses

The chat must receive exactly ONE finalized conversational response.

Even if you internally compare multiple possible responses, the user
must see ONLY the final selected response.

Stay in character.
`.trim();

    /* ================================================================
       13. BUILD MODEL CONVERSATION
    ================================================================= */

    const modelHistory = recentHistory
      .slice(-12)
      .map((row) => ({
        role:
          row.sender_role === "replica"
            ? "assistant"
            : "user",
        content: cleanText(
          row.message_text,
        ),
      }))
      .filter(
        (row) => row.content,
      );

    const messages = [
      {
        role: "system" as const,
        content: systemPrompt,
      },

      ...modelHistory,

      {
        role: "user" as const,
        content: data.message,
      },
    ];

    /* ================================================================
       14. OPENROUTER CONFIG
    ================================================================= */

    const apiKey =
      process.env["OPENROUTER_API_KEY"];

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
       15. GENERATE RESPONSE
       
       Lower temperature than before because this is a faithful replica,
       not a creative chatbot.
       
       Reasoning is explicitly disabled/excluded.
    ================================================================= */

    let reply = "";
    let openRouterMeta: Record<
      string,
      unknown
    > = {};

    const attemptLimit = 2;

    for (
      let attempt = 1;
      attempt <= attemptLimit;
      attempt += 1
    ) {
      const controller =
        new AbortController();

      const timeout = setTimeout(
        () => controller.abort(),
        45_000,
      );

      try {
        const response = await fetch(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",

              Authorization:
                `Bearer ${apiKey}`,

              "HTTP-Referer":
                "https://always-together.vercel.app",

              "X-Title":
                "Always Together",
            },

            body: JSON.stringify({
              model: "openrouter/free",

              messages,

              temperature: 0.55,

              top_p: 0.9,

              max_tokens: 500,

              // Prevent reasoning from being returned to the client.
              reasoning: {
                enabled: false,
                exclude: true,
              },
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
            await new Promise(
              (resolve) =>
                setTimeout(
                  resolve,
                  1200,
                ),
            );

            continue;
          }

          return {
            ok: false,
            reply: "",
            messageId: null,
            generatedResponseId: null,
            usedMemories:
              memoryHits.length,
            errorKind: "rate_limit",
            error:
              "OpenRouter is rate limiting requests right now. Try again in a moment.",
          };
        }

        /* ------------------------------------------------------------
           SERVER ERROR RETRY
        ------------------------------------------------------------ */

        if (!response.ok) {
          const body =
            await response.text();

          console.error(
            `[openrouter] ${response.status}: ${body}`,
          );

          if (
            attempt < attemptLimit &&
            response.status >= 500
          ) {
            await new Promise(
              (resolve) =>
                setTimeout(
                  resolve,
                  700 * attempt,
                ),
            );

            continue;
          }

          let readableError =
            `The AI service returned an error (${response.status}).`;

          try {
            const parsed =
              JSON.parse(body) as {
                error?: {
                  message?: string;
                };
              };

            if (
              parsed?.error?.message
            ) {
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
            generatedResponseId:
              null,
            usedMemories:
              memoryHits.length,
            errorKind: "grok",
            error: readableError,
          };
        }

        /* ------------------------------------------------------------
           PARSE RESPONSE
        ------------------------------------------------------------ */

        const payload =
          (await response.json()) as {
            choices?: {
              message?: {
                content?: string;
              };
            }[];

            usage?: Record<
              string,
              unknown
            >;

            model?: string;

            id?: string;

            reasoning_details?: unknown;
          };

        const rawReply =
          payload.choices?.[0]
            ?.message?.content ?? "";

        reply =
          sanitizeFinalReply(
            rawReply,
          );

        openRouterMeta = {
          provider: "openrouter",
          model:
            payload.model ??
            "openrouter/free",
          request_id:
            payload.id ?? null,
          usage:
            payload.usage ?? {},
          attempt,

          retrieval: {
            similar_exchanges:
              uniqueExchanges.length,
            authentic_messages:
              uniqueReplicaMessages.length,
            memories:
              memoryHits.length,
          },

          reasoning_removed: true,
        };

        /* ------------------------------------------------------------
           EMPTY / INVALID RESPONSE
        ------------------------------------------------------------ */

        if (!reply) {
          if (attempt < attemptLimit) {
            continue;
          }

          return {
            ok: false,
            reply: "",
            messageId: null,
            generatedResponseId:
              null,
            usedMemories:
              memoryHits.length,
            errorKind: "grok",
            error:
              "The AI service returned no usable final response.",
          };
        }

        break;
      } catch (error) {
        clearTimeout(timeout);

        const aborted =
          error instanceof Error &&
          error.name ===
            "AbortError";

        if (attempt < attemptLimit) {
          continue;
        }

        return {
          ok: false,
          reply: "",
          messageId: null,
          generatedResponseId:
            null,
          usedMemories:
            memoryHits.length,
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
       16. FINAL SAFETY CHECK
       
       Never save/display an obviously empty response.
    ================================================================= */

    reply = sanitizeFinalReply(
      reply,
    );

    if (!reply) {
      return {
        ok: false,
        reply: "",
        messageId: null,
        generatedResponseId:
          null,
        usedMemories:
          memoryHits.length,
        errorKind: "grok",
        error:
          "No valid final response was generated.",
      };
    }

    /* ================================================================
       17. SAVE GENERATED RESPONSE
    ================================================================= */

    const {
      data: generated,
      error: generatedError,
    } = await supabase
      .from("generated_responses")
      .insert({
        owner_id: uid,

        replica_id:
          data.replicaId,

        user_message:
          data.message,

        generated_response:
          reply,

        retrieval_context: {
          query:
            data.message,

          similar_exchanges:
            uniqueExchanges.length,

          authentic_messages:
            uniqueReplicaMessages.length,

          memories:
            memoryHits
              .slice(0, 8)
              .map(
                (m) =>
                  m.title,
              ),

          history:
            history.length,
        },

        generation_metadata:
          openRouterMeta,
      })
      .select("id")
      .single();

    if (generatedError) {
      return {
        ok: false,
        reply,
        messageId: null,
        generatedResponseId:
          null,
        usedMemories:
          memoryHits.length,
        errorKind: "database",
        error:
          generatedError.message,
      };
    }

    /* ================================================================
       18. SAVE REPLICA MESSAGE
    ================================================================= */

    const {
      data: stored,
      error: storeError,
    } = await supabase
      .from("chat_session_messages")
      .insert({
        owner_id: uid,

        session_id:
          data.sessionId,

        sender_role:
          "replica",

        message_text:
          reply,

        generated_response_id:
          generated.id,

        reply_to_message_id:
          data.replyToMessageId ??
          null,
      })
      .select("id")
      .single();

    if (storeError) {
      return {
        ok: false,
        reply,
        messageId: null,
        generatedResponseId:
          generated.id as string,
        usedMemories:
          memoryHits.length,
        errorKind: "database",
        error:
          storeError.message,
      };
    }

    /* ================================================================
       19. UPDATE SESSION
    ================================================================= */

    await supabase
      .from("chat_sessions")
      .update({
        updated_at:
          new Date().toISOString(),
      })
      .eq(
        "id",
        data.sessionId,
      );

    /* ================================================================
       20. SUCCESS
    ================================================================= */

    return {
      ok: true,

      reply,

      messageId:
        stored.id as string,

      generatedResponseId:
        generated.id as string,

      usedMemories:
        memoryHits.length,
    };
  });
