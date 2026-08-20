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
  created_at?: string | null;
};

/* =====================================================================
   HELPERS
===================================================================== */

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clampText(value: unknown, max: number): string {
  const text = cleanText(value);

  if (text.length <= max) {
    return text;
  }

  return `${text.slice(0, max)}…`;
}

/**
 * Remove accidental model reasoning / meta output.
 *
 * The model is instructed not to produce this, but this final layer
 * protects the actual chat UI if a provider/model does it anyway.
 */
function sanitizeFinalReply(raw: string): string {
  let text = cleanText(raw);

  if (!text) {
    return "";
  }

  text = text.replace(
    /<think>[\s\S]*?<\/think>/gi,
    "",
  );

  text = text.replace(
    /<analysis>[\s\S]*?<\/analysis>/gi,
    "",
  );

  text = text.replace(
    /<reasoning>[\s\S]*?<\/reasoning>/gi,
    "",
  );

  text = text.replace(
    /```(?:analysis|reasoning|thinking)[\s\S]*?```/gi,
    "",
  );

  text = text.trim();

  text = text.replace(
    /^(?:analysis|reasoning|thinking|internal reasoning)\s*:\s*/i,
    "",
  );

  /*
   * If the model starts talking about being an AI/model or about
   * retrieval, reject it instead of displaying it to the user.
   */
  if (
    /^(?:as an ai|as a language model|i am an ai|i'm an ai|i cannot reveal my reasoning|according to the dataset|according to the memories|based on the retrieved|based on the context)/i.test(
      text,
    )
  ) {
    return "";
  }

  return text.trim();
}

/**
 * Remove duplicate retrieval rows while preserving ranking order.
 */
function uniqueBy<T>(
  rows: T[],
  key: (row: T) => string,
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const row of rows) {
    const value = key(row);

    if (!value || seen.has(value)) {
      continue;
    }

    seen.add(value);
    result.push(row);
  }

  return result;
}

/**
 * Normalize whitespace for lightweight comparison.
 */
function normalizeForComparison(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detect an obvious copy/echo of the user's current message.
 *
 * This is deliberately conservative. We mainly want to prevent the
 * exact failure where the replica simply sends the user's own message
 * back unchanged.
 */
function isObviousEcho(
  userMessage: string,
  reply: string,
): boolean {
  const user = normalizeForComparison(userMessage);
  const answer = normalizeForComparison(reply);

  if (!user || !answer) {
    return false;
  }

  if (user === answer) {
    return true;
  }

  /*
   * For longer messages, also catch a reply that is almost entirely
   * the user's exact message.
   */
  if (
    user.length >= 25 &&
    answer.length >= 25 &&
    (answer.includes(user) || user.includes(answer))
  ) {
    const ratio =
      Math.min(user.length, answer.length) /
      Math.max(user.length, answer.length);

    if (ratio >= 0.92) {
      return true;
    }
  }

  return false;
}

/* =====================================================================
   SERVER FUNCTION
===================================================================== */

export const generateReply = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    generateSchema.parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<GenerateReplyResult> => {
      const {
        verifyFirebaseIdToken,
        createUserScopedSupabase,
      } = await import(
        "./firebase-verify.server"
      );

      /* ================================================================
         1. FIREBASE AUTHENTICATION
      ================================================================ */

      let uid: string;

      try {
        uid = (
          await verifyFirebaseIdToken(
            data.idToken,
          )
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
      ================================================================ */

      const supabase =
        await createUserScopedSupabase(
          data.idToken,
        );

      /* ================================================================
         3. VERIFY REPLICA OWNERSHIP
      ================================================================ */

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
         4. IDEMPOTENCY PROTECTION
         
         If the frontend accidentally sends the same request twice,
         don't create two replica messages for the same user message.
      ================================================================ */

      if (data.replyToMessageId) {
        const {
          data: existingReply,
          error: existingReplyError,
        } = await supabase
          .from("chat_session_messages")
          .select(
            "id, message_text, generated_response_id",
          )
          .eq(
            "session_id",
            data.sessionId,
          )
          .eq(
            "reply_to_message_id",
            data.replyToMessageId,
          )
          .eq(
            "sender_role",
            "replica",
          )
          .limit(1)
          .maybeSingle();

        if (
          !existingReplyError &&
          existingReply?.message_text
        ) {
          return {
            ok: true,
            reply:
              existingReply.message_text,
            messageId:
              (existingReply.id as string) ??
              null,
            generatedResponseId:
              (existingReply.generated_response_id as string) ??
              null,
            usedMemories: 0,
          };
        }
      }

      /* ================================================================
         5. LOAD STYLE + PARTICIPANTS + HISTORY
         
         These are independent reads, so run them in parallel.
      ================================================================ */

      const [
        styleResult,
        participantsResult,
        historyResult,
      ] = await Promise.all([
        supabase
          .from("replica_style_profiles")
          .select("*")
          .eq(
            "replica_id",
            data.replicaId,
          )
          .maybeSingle(),

        supabase
          .from("replica_participants")
          .select(
            "display_name, role, message_count",
          )
          .eq(
            "replica_id",
            data.replicaId,
          )
          .order(
            "message_count",
            {
              ascending: false,
            },
          )
          .limit(6),

        supabase
          .from("chat_session_messages")
          .select(
            "sender_role, message_text, created_at",
          )
          .eq(
            "session_id",
            data.sessionId,
          )
          .order(
            "created_at",
            {
              ascending: false,
            },
          )
          .limit(16),
      ]);

      const style = styleResult.data;

      const participants =
        participantsResult.data ?? [];

      const history =
        (historyResult.data ??
          []) as ChatHistoryRow[];

      /* ================================================================
         6. DETERMINE REPLICA NAME
      ================================================================ */

      const replicaParticipant =
        participants.find(
          (participant) =>
            participant.role ===
            "replica",
        );

      const replicaName =
        replicaParticipant?.display_name ??
        replica.name;

      /* ================================================================
         7. RECENT CONVERSATION CONTEXT
         
         Recent history is used to understand the current situation.
         
         IMPORTANT:
         It is NOT passed into the similarity RPC as the search query.
         The similarity RPC receives the actual current user message.
      ================================================================ */

      const recentHistory =
        history
          .slice()
          .reverse()
          .filter(
            (row) =>
              cleanText(
                row.message_text,
              ),
          );

      const recentContext =
        recentHistory
          .slice(-8)
          .map(
            (row) =>
              `${
                row.sender_role ===
                "replica"
                  ? "REPLICA"
                  : "USER"
              }: ${clampText(
                row.message_text,
                450,
              )}`,
          )
          .join("\n");

      /* ================================================================
         8. RETRIEVE AUTHENTIC DATA
         
         This is the most important part.
         
         Current message
                ↓
         search_similar_exchanges
                ↓
         historical USER message + actual REPLICA reply
         
         That pair is the strongest evidence for how this person
         responds in a similar situation.
      ================================================================ */

      const [
        exchangeResult,
        replicaMessageResult,
        memoryResult,
      ] = await Promise.all([
        supabase.rpc(
          "search_similar_exchanges",
          {
            p_replica_id:
              data.replicaId,

            /*
             * VERY IMPORTANT:
             * Search using the actual user message.
             *
             * Do NOT use recentContext here.
             */
            p_query:
              data.message,

            p_limit: 10,
          },
        ),

        supabase.rpc(
          "search_replica_messages",
          {
            p_replica_id:
              data.replicaId,

            p_query:
              data.message,

            p_limit: 10,
          },
        ),

        supabase.rpc(
          "search_memories",
          {
            p_replica_id:
              data.replicaId,

            p_query:
              data.message,

            p_limit: 8,
          },
        ),
      ]);

      const similarExchanges =
        (
          (exchangeResult.data ??
            []) as RetrievalExchange[]
        ).filter(
          (row) =>
            cleanText(
              row.prompt_text,
            ) &&
            cleanText(
              row.reply_text,
            ),
        );

      const replicaMessages =
        (
          (replicaMessageResult.data ??
            []) as RetrievedMessage[]
        ).filter(
          (row) =>
            cleanText(
              row.message_text,
            ),
        );

      const memoryHits =
        (
          (memoryResult.data ??
            []) as RetrievedMemory[]
        ).filter(
          (row) =>
            cleanText(row.title) ||
            cleanText(
              row.description,
            ),
        );

      /* ================================================================
         9. REMOVE DUPLICATES
      ================================================================ */

      const uniqueExchanges =
        uniqueBy(
          similarExchanges,
          (row) =>
            `${normalizeForComparison(
              cleanText(
                row.prompt_text,
              ),
            )}|||${normalizeForComparison(
              cleanText(
                row.reply_text,
              ),
            )}`,
        ).slice(0, 8);

      const uniqueReplicaMessages =
        uniqueBy(
          replicaMessages,
          (row) =>
            normalizeForComparison(
              cleanText(
                row.message_text,
              ),
            ),
        ).slice(0, 10);

      /* ================================================================
         10. STYLE PROFILE
      ================================================================ */

      const vocabularyProfile =
        style?.vocabulary_profile as
          | {
              signature_phrases?: unknown;
            }
          | null
          | undefined;

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
                vocabularyProfile
                  ?.signature_phrases,
            },
          ).slice(0, 4500)
        : "No measured style profile is available.";

      /* ================================================================
         11. BUILD HISTORICAL EXCHANGE EVIDENCE
      ================================================================ */

      const exchangeEvidence =
        uniqueExchanges.length
          ? uniqueExchanges
              .map(
                (
                  row,
                  index,
                ) =>
                  `[HISTORICAL EXCHANGE ${
                    index + 1
                  }]
USER MESSAGE:
${clampText(
  row.prompt_text,
  550,
)}

REPLICA'S ACTUAL REPLY:
${clampText(
  row.reply_text,
  550,
)}

SIMILARITY:
${
  typeof row.similarity ===
  "number"
    ? row.similarity.toFixed(
        3,
      )
    : "unknown"
}`,
              )
              .join(
                "\n\n",
              )
          : "No directly similar historical exchange was retrieved.";

      /* ================================================================
         12. BUILD AUTHENTIC MESSAGE EVIDENCE
      ================================================================ */

      const messageEvidence =
        uniqueReplicaMessages.length
          ? uniqueReplicaMessages
              .map(
                (
                  row,
                  index,
                ) =>
                  `${index + 1}. ${clampText(
                    row.message_text,
                    300,
                  )}`,
              )
              .join("\n")
          : "No additional authentic replica messages were retrieved.";

      /* ================================================================
         13. BUILD MEMORY EVIDENCE
      ================================================================ */

      const memoryEvidence =
        memoryHits.length
          ? memoryHits
              .slice(0, 8)
              .map(
                (
                  memory,
                  index,
                ) =>
                  `${index + 1}. ${
                    cleanText(
                      memory.title,
                    ) ||
                    "Memory"
                  }: ${clampText(
                    memory.description,
                    450,
                  )}`,
              )
              .join("\n")
          : "No relevant stored memories were retrieved.";

      /* ================================================================
         14. OPENROUTER CONFIG
      ================================================================ */

      const apiKey =
        process.env[
          "OPENROUTER_API_KEY"
        ];

      if (!apiKey) {
        return {
          ok: false,
          reply: "",
          messageId: null,
          generatedResponseId: null,
          usedMemories:
            memoryHits.length,
          errorKind: "grok",
          error:
            "The AI backend is not configured (missing OPENROUTER_API_KEY).",
        };
      }

      /* ================================================================
         15. SYSTEM PROMPT
      ================================================================ */

      const systemPrompt = `
You are the conversational replica of "${replicaName}".

Your ONLY job is to produce the single message that this person would
most naturally send in response to the user's CURRENT message.

You are NOT a generic AI assistant.

You are NOT supposed to answer the question in a generic helpful way.

You must imitate the person's actual conversational behavior from the
historical dataset.

==================================================
MOST IMPORTANT RULE: HISTORICAL RESPONSE MATCHING
==================================================

The database contains historical conversations from this person.

Each useful historical exchange has:

USER MESSAGE
+
THE REPLICA PERSON'S ACTUAL REPLY

Those historical USER → REPLICA pairs are your strongest evidence.

For the current user message:

1. Understand what the user means.
2. Understand the emotional and conversational situation.
3. Examine the historical exchanges.
4. Find the exchange whose SITUATION and INTENT are closest.
5. Examine how the replica actually replied there.
6. Use that response pattern as the primary template.
7. Adapt it naturally to the current situation.
8. Preserve the person's actual style and wording whenever appropriate.
9. Return ONE final response.

Do NOT simply choose the message with the most similar words.

A semantically similar situation is more important than a keyword match.

For example:

If the user says something affectionate and the dataset contains
multiple affectionate exchanges, use the actual affectionate response
patterns.

If the user is teasing, prefer historical teasing responses.

If the user is asking a question, prefer historical responses to similar
questions.

If the user says something short and casual, prefer short casual
historical replies.

If the user is emotional, use historical emotional-response behavior.

==================================================
CRITICAL ANTI-ECHO RULE
==================================================

NEVER send the user's current message back to them.

NEVER simply copy the current user message.

The user's current message is INPUT.

The replica's response must be OUTPUT.

Even if a historical user message looks almost identical to the current
message, do NOT output the historical USER MESSAGE.

Only the historical REPLICA'S ACTUAL REPLY can be used as a response
example.

If the current user says:

"Teri yad ari"

and the database contains:

USER:
"Teri yad arhi"

REPLICA:
"..." 

then the answer must be based on the REPLICA response, NOT on the user's
"Teri yad arhi" message.

==================================================
CONVERSATIONAL CONTEXT
==================================================

Use recent conversation history to understand references and meaning.

Words such as:

"acha"
"haan"
"sun"
"oye"
"that"
"this"
"him"
"her"
"there"
"kyu"
"ku"
"bss"
"piddi"
etc.

may depend completely on previous messages.

Do not treat the current message as isolated when recent conversation
changes its meaning.

==================================================
STYLE FIDELITY
==================================================

Match the person's:

- Urdu / Roman Urdu / English mix
- slang
- spelling
- abbreviations
- sentence structure
- message length
- punctuation
- capitalization
- emojis
- repeated phrases
- teasing
- humor
- affection
- sarcasm
- conversational rhythm
- use of nicknames
- degree of formality

Do NOT make the response cleaner, more formal, or more grammatically
correct than the person's actual historical style.

If their historical messages are short, stay short.

If they commonly use emojis, use them naturally.

If they commonly use Roman Urdu, use Roman Urdu.

If they mix English and Urdu, preserve that mix.

Do not force a style feature into every answer.

==================================================
PERSONAL FACTS
==================================================

Only use facts supported by:

- historical exchanges
- recent chat history
- retrieved memories
- replica description
- measured style profile

Never invent:

- events
- memories
- relationships
- locations
- schedules
- personal history
- feelings
- promises
- conversations

==================================================
WHEN THERE IS NO GOOD MATCH
==================================================

If there is no highly similar historical exchange:

1. Use the person's authentic replica messages.
2. Use the style profile.
3. Use relevant memories.
4. Use recent conversation context.
5. Infer the most natural response consistent with the person's
   established behavior.

Do NOT produce a generic ChatGPT answer.

==================================================
RETRIEVED HISTORICAL EXCHANGES
==================================================

${exchangeEvidence}

==================================================
AUTHENTIC REPLICA MESSAGES
==================================================

${messageEvidence}

==================================================
RELEVANT MEMORIES
==================================================

${memoryEvidence}

==================================================
MEASURED STYLE PROFILE
==================================================

${styleSummary}

==================================================
OWNER INSTRUCTIONS
==================================================

${
  cleanText(
    style?.custom_instructions,
  ) ||
  "No additional owner instructions."
}

==================================================
FINAL OUTPUT
==================================================

Return ONLY the exact final conversational message the replica should
send.

ONE response.

No reasoning.

No analysis.

No explanation.

No candidate responses.

No confidence score.

No labels.

No JSON.

No markdown explanation.

No dataset references.

No memory references.

No mention of AI.

No mention of OpenRouter.

No mention of being a replica.

Do not repeat the user's current message.

Do not quote the user's current message unless the person's natural
historical conversational style clearly requires quoting a tiny part of
it.

The final output must be ready to display directly in the chat UI.

Stay completely in character.
`.trim();

      /* ================================================================
         16. MODEL CHAT HISTORY
      ================================================================ */

      const modelHistory =
        recentHistory
          .slice(-10)
          .map(
            (row) => ({
              role:
                row.sender_role ===
                "replica"
                  ? ("assistant" as const)
                  : ("user" as const),

              content:
                cleanText(
                  row.message_text,
                ),
            }),
          )
          .filter(
            (row) =>
              row.content,
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
      ];      /* ================================================================
         17. GENERATE RESPONSE
         
         Fast + faithful:
         - low temperature
         - short output limit
         - reasoning excluded
         - only one retry for transient failures
      ================================================================ */

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

        /*
         * 30 seconds keeps the chat responsive while still allowing
         * the model enough time to answer.
         */
        const timeout =
          setTimeout(
            () =>
              controller.abort(),
            30_000,
          );

        try {
          const response =
            await fetch(
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
                  model:
                    "openrouter/free",

                  messages,

                  /*
                   * Lower temperature makes the model follow the
                   * retrieved historical behavior more consistently
                   * instead of inventing a new personality.
                   */
                  temperature:
                    0.45,

                  top_p: 0.9,

                  /*
                   * Replica replies should normally be conversational,
                   * so there is no reason to allow huge outputs.
                   */
                  max_tokens:
                    350,

                  /*
                   * OpenRouter supports reasoning controls. We do not
                   * want reasoning returned as the chat response.
                   */
                  reasoning: {
                    enabled: false,
                    exclude: true,
                  },
                }),

                signal:
                  controller.signal,
              },
            );

          clearTimeout(
            timeout,
          );

          /* ------------------------------------------------------------
             RATE LIMIT
          ------------------------------------------------------------ */

          if (
            response.status ===
            429
          ) {
            if (
              attempt <
              attemptLimit
            ) {
              await new Promise(
                (resolve) =>
                  setTimeout(
                    resolve,
                    900,
                  ),
              );

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
              errorKind:
                "rate_limit",
              error:
                "OpenRouter is rate limiting requests right now. Try again in a moment.",
            };
          }

          /* ------------------------------------------------------------
             TRANSIENT SERVER ERRORS
          ------------------------------------------------------------ */

          if (
            !response.ok
          ) {
            const body =
              await response.text();

            console.error(
              `[openrouter] ${response.status}: ${body}`,
            );

            /*
             * Retry only server-side failures.
             * Do not waste time retrying authentication/request errors.
             */
            if (
              attempt <
                attemptLimit &&
              response.status >=
                500
            ) {
              await new Promise(
                (resolve) =>
                  setTimeout(
                    resolve,
                    500,
                  ),
              );

              continue;
            }

            let readableError =
              `The AI service returned an error (${response.status}).`;

            try {
              const parsed =
                JSON.parse(
                  body,
                ) as {
                  error?: {
                    message?: string;
                  };
                };

              if (
                parsed?.error
                  ?.message
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
              errorKind:
                "grok",
              error:
                readableError,
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
            };

          const rawReply =
            payload
              .choices?.[0]
              ?.message
              ?.content ??
            "";

          reply =
            sanitizeFinalReply(
              rawReply,
            );

          openRouterMeta = {
            provider:
              "openrouter",

            model:
              payload.model ??
              "openrouter/free",

            request_id:
              payload.id ??
              null,

            usage:
              payload.usage ??
              {},

            attempt,

            retrieval: {
              similar_exchanges:
                uniqueExchanges.length,

              authentic_messages:
                uniqueReplicaMessages.length,

              memories:
                memoryHits.length,

              /*
               * Useful when diagnosing retrieval quality.
               */
              current_message:
                data.message,
            },

            reasoning_excluded:
              true,
          };

          /* ------------------------------------------------------------
             EMPTY RESPONSE
          ------------------------------------------------------------ */

          if (!reply) {
            if (
              attempt <
              attemptLimit
            ) {
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
              errorKind:
                "grok",
              error:
                "The AI service returned no usable final response.",
            };
          }

          /* ------------------------------------------------------------
             ANTI-ECHO CHECK
          ------------------------------------------------------------ */

          if (
            isObviousEcho(
              data.message,
              reply,
            )
          ) {
            console.warn(
              "[generateReply] Model returned an obvious echo of the user's message.",
            );

            /*
             * Retry once with an explicit anti-copy instruction.
             *
             * This is intentionally done without another database query,
             * so the response remains fast.
             */
            if (
              attempt <
              attemptLimit
            ) {
              messages.push({
                role:
                  "system" as const,

                content:
                  "IMPORTANT: Your previous draft copied the user's message. Generate a NEW response from the replica's historical replies. NEVER return the user's message itself.",
              });

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
              errorKind:
                "grok",
              error:
                "The generated response was rejected because it copied the user's message.",
            };
          }

          break;
        } catch (error) {
          clearTimeout(
            timeout,
          );

          const aborted =
            error instanceof Error &&
            error.name ===
              "AbortError";

          if (
            attempt <
            attemptLimit
          ) {
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
            errorKind:
              aborted
                ? "timeout"
                : "unknown",
            error:
              aborted
                ? "The AI service took too long to respond. Try again."
                : "Could not reach OpenRouter. Check your connection and retry.",
          };
        }
      }

      /* ================================================================
         18. FINAL VALIDATION
      ================================================================ */

      reply =
        sanitizeFinalReply(
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
          errorKind:
            "grok",
          error:
            "No valid final response was generated.",
        };
      }

      if (
        isObviousEcho(
          data.message,
          reply,
        )
      ) {
        return {
          ok: false,
          reply: "",
          messageId: null,
          generatedResponseId:
            null,
          usedMemories:
            memoryHits.length,
          errorKind:
            "grok",
          error:
            "The generated response was rejected because it copied the user's message.",
        };
      }

      /* ================================================================
         19. SAVE GENERATED RESPONSE
      ================================================================ */

      const {
        data: generated,
        error: generatedError,
      } = await supabase
        .from(
          "generated_responses",
        )
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
                  (memory) =>
                    memory.title,
                ),

            history:
              history.length,
          },

          generation_metadata:
            openRouterMeta,
        })
        .select("id")
        .single();

      if (
        generatedError
      ) {
        return {
          ok: false,
          reply,
          messageId: null,
          generatedResponseId:
            null,
          usedMemories:
            memoryHits.length,
          errorKind:
            "database",
          error:
            generatedError.message,
        };
      }

      /* ================================================================
         20. SAVE REPLICA CHAT MESSAGE
      ================================================================ */

      const {
        data: stored,
        error: storeError,
      } = await supabase
        .from(
          "chat_session_messages",
        )
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
          errorKind:
            "database",
          error:
            storeError.message,
        };
      }

      /* ================================================================
         21. UPDATE CHAT SESSION
      ================================================================ */

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
         22. SUCCESS
      ================================================================ */

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
    },
  );
