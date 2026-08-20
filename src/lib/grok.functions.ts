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

/* ================================================================
   TYPES
================================================================ */

type HistoricalMessage = {
  id: number;
  sender_role: string | null;
  sender_name: string | null;
  message_text: string | null;
  reply_to_message_id: number | null;
  sent_at: string | null;
};

type SimilarExchange = {
  userMessage: string;
  replicaReply: string;
  similarity: number;
};

type StyleProfile = {
  language_profile?: unknown;
  emoji_profile?: unknown;
  punctuation_profile?: unknown;
  response_length_profile?: unknown;
  greeting_profile?: unknown;
  humor_profile?: unknown;
  vocabulary_profile?: unknown;
  custom_instructions?: unknown;
};

/* ================================================================
   HELPERS
================================================================ */

function cleanText(value: unknown): string {
  return typeof value === "string"
    ? value.trim()
    : "";
}

function clamp(
  value: string,
  max: number,
): string {
  return value.length > max
    ? `${value.slice(0, max)}…`
    : value;
}

function normalizeText(
  value: string,
): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(
  value: string,
): string[] {
  return normalizeText(value)
    .split(" ")
    .filter(
      (word) =>
        word.length >= 2,
    );
}

/* ================================================================
   SIMPLE LOCAL SIMILARITY
   Used only to rank messages already retrieved from Supabase.
================================================================ */

function similarityScore(
  query: string,
  candidate: string,
): number {
  const queryWords = new Set(
    tokenize(query),
  );

  const candidateWords = new Set(
    tokenize(candidate),
  );

  if (
    queryWords.size === 0 ||
    candidateWords.size === 0
  ) {
    return 0;
  }

  let overlap = 0;

  for (const word of queryWords) {
    if (candidateWords.has(word)) {
      overlap++;
    }
  }

  const union = new Set([
    ...queryWords,
    ...candidateWords,
  ]).size;

  if (!union) return 0;

  return overlap / union;
}

/* ================================================================
   REMOVE OBVIOUS MODEL META / REASONING
================================================================ */

function sanitizeReply(
  raw: string,
): string {
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
    /^(?:analysis|reasoning|thinking)\s*:\s*/i,
    "",
  );

  if (
    /^(?:as an ai|as a language model|i am an ai|according to the dataset|based on the context)/i.test(
      text,
    )
  ) {
    return "";
  }

  return text.trim();
}

/* ================================================================
   PREVENT ECHOING THE USER
================================================================ */

function looksLikeEcho(
  userMessage: string,
  reply: string,
): boolean {
  const user = normalizeText(
    userMessage,
  );

  const answer = normalizeText(
    reply,
  );

  if (!user || !answer) {
    return false;
  }

  if (user === answer) {
    return true;
  }

  if (
    answer.length >= user.length * 0.9 &&
    answer.length <= user.length * 1.15
  ) {
    const score = similarityScore(
      user,
      answer,
    );

    if (score >= 0.85) {
      return true;
    }
  }

  return false;
}

/* ================================================================
   SERVER FUNCTION
================================================================ */

export const generateReply = createServerFn({
  method: "POST",
})
  .inputValidator(
    (input: unknown) =>
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

      /* ============================================================
         1. AUTHENTICATE USER
      ============================================================ */

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

      /* ============================================================
         2. USER-SCOPED SUPABASE
      ============================================================ */

      const supabase =
        await createUserScopedSupabase(
          data.idToken,
        );

      /* ============================================================
         3. VERIFY REPLICA OWNERSHIP
      ============================================================ */

      const {
        data: replica,
        error: replicaError,
      } = await supabase
        .from("replicas")
        .select(
          "id, name, description, owner_id",
        )
        .eq(
          "id",
          data.replicaId,
        )
        .maybeSingle();

      if (replicaError) {
        return {
          ok: false,
          reply: "",
          messageId: null,
          generatedResponseId: null,
          usedMemories: 0,
          errorKind: "database",
          error:
            replicaError.message,
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

      /* ============================================================
         4. LOAD STYLE + PARTICIPANTS + RECENT CHAT
      ============================================================ */

      const [
        styleResult,
        participantsResult,
        historyResult,
      ] = await Promise.all([
        supabase
          .from(
            "replica_style_profiles",
          )
          .select("*")
          .eq(
            "replica_id",
            data.replicaId,
          )
          .maybeSingle(),

        supabase
          .from(
            "replica_participants",
          )
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
          .limit(10),

        supabase
          .from(
            "chat_session_messages",
          )
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
          .limit(20),
      ]);

      const style =
        styleResult.data as StyleProfile | null;

      const participants =
        participantsResult.data ?? [];

      const history =
        historyResult.data ?? [];

      /* ============================================================
         5. DETERMINE REPLICA NAME
      ============================================================ */

      const replicaParticipant =
        participants.find(
          (participant) =>
            participant.role ===
            "replica",
        );

      const replicaName =
        replicaParticipant
          ?.display_name ??
        replica.name;

      /* ============================================================
         6. BUILD RECENT CONVERSATION CONTEXT
      ============================================================ */

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
              }: ${clamp(
                cleanText(
                  row.message_text,
                ),
                500,
              )}`,
          )
          .join("\n");

      /* ============================================================
         7. PREPARE SEARCH TERMS
         
         We intentionally search historical USER messages.
         The critical relationship is:

         HISTORICAL USER MESSAGE
                    ↓
         HISTORICAL REPLICA RESPONSE

         This prevents the previous bug where the system found:
         "Teri yad arhi"

         and then treated that USER message itself as an answer.
      ============================================================ */

      const normalizedUserMessage =
        normalizeText(
          data.message,
        );

      const searchWords =
        tokenize(
          data.message,
        )
          .filter(
            (word) =>
              word.length >= 3,
          )
          .slice(0, 8);

      /* ============================================================
         8. LOAD HISTORICAL USER MESSAGES
         
         IMPORTANT:
         sender_role = "me" means the original chat sender.
         
         We retrieve those messages first, then locate the replica
         response associated with them.
      ============================================================ */

      let historicalCandidates:
        HistoricalMessage[] = [];

      if (
        searchWords.length > 0
      ) {
        const searchPattern =
          searchWords
            .map(
              (word) =>
                `%${word}%`,
            );

        const candidateQueries =
          searchPattern
            .slice(0, 4)
            .map(
              (pattern) =>
                supabase
                  .from("messages")
                  .select(
                    "id, sender_role, sender_name, message_text, reply_to_message_id, sent_at",
                  )
                  .eq(
                    "replica_id",
                    data.replicaId,
                  )
                  .eq(
                    "sender_role",
                    "me",
                  )
                  .ilike(
                    "message_text",
                    pattern,
                  )
                  .not(
                    "message_text",
                    "is",
                    null,
                  )
                  .order(
                    "sent_at",
                    {
                      ascending: false,
                    },
                  )
                  .limit(40),
            );

        const candidateResults =
          await Promise.all(
            candidateQueries,
          );

        for (const result of candidateResults) {
          if (
            result.data
          ) {
            historicalCandidates.push(
              ...(result.data as HistoricalMessage[]),
            );
          }
        }
      }

      /* ============================================================
         9. FALLBACK CANDIDATE SEARCH
         
         If keyword search finds nothing, use recent messages from
         this replica as a fallback. This is still restricted to
         USER messages.
      ============================================================ */

      if (
        historicalCandidates.length ===
        0
      ) {
        const {
          data: fallbackRows,
        } = await supabase
          .from("messages")
          .select(
            "id, sender_role, sender_name, message_text, reply_to_message_id, sent_at",
          )
          .eq(
            "replica_id",
            data.replicaId,
          )
          .eq(
            "sender_role",
            "me",
          )
          .not(
            "message_text",
            "is",
            null,
          )
          .order(
            "sent_at",
            {
              ascending: false,
            },
          )
          .limit(80);

        historicalCandidates =
          (fallbackRows ??
            []) as HistoricalMessage[];
      }

      /* ============================================================
         10. DEDUPLICATE USER CANDIDATES
      ============================================================ */

      const uniqueCandidates =
        Array.from(
          new Map(
            historicalCandidates.map(
              (row) => [
                normalizeText(
                  cleanText(
                    row.message_text,
                  ),
                ),
                row,
              ],
            ),
          ).values(),
        ).filter(
          (row) =>
            cleanText(
              row.message_text,
            ),
        );

      /* ============================================================
         11. RANK HISTORICAL USER MESSAGES
      ============================================================ */

      const rankedCandidates =
        uniqueCandidates
          .map(
            (row) => ({
              row,
              similarity:
                similarityScore(
                  data.message,
                  cleanText(
                    row.message_text,
                  ),
                ),
            }),
          )
          .sort(
            (a, b) =>
              b.similarity -
              a.similarity,
          )
          .slice(0, 20);

      /* ============================================================
         PART 1 ENDS HERE
         
         NEXT PART CONTINUES WITH:
         - finding actual replica replies
         - pairing USER → REPLICA exchanges
         - memories
         - style
         - OpenRouter prompt
         - generation
      ============================================================ */    /* ================================================================
       7. BUILD RETRIEVAL QUERY
    ================================================================= */

    const recentHistory = (history ?? [])
      .slice()
      .reverse()
      .filter((row) => cleanText(row.message_text));

    const recentContext = recentHistory
      .slice(-8)
      .map((row) => {
        const role =
          row.sender_role === "replica"
            ? "REPLICA"
            : "USER";

        return `${role}: ${clampText(
          cleanText(row.message_text),
          500,
        )}`;
      })
      .join("\n");

    const retrievalQuery = [
      recentContext
        ? `Recent conversation:\n${recentContext}`
        : "",
      `Current message:\n${cleanText(data.message)}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    /* ================================================================
       8. RETRIEVE ACTUAL HISTORICAL EXCHANGES

       MOST IMPORTANT PART:

       We want:

       USER MESSAGE / SITUATION
                    ↓
       ACTUAL REPLICA RESPONSE

       The model should learn from the response that the replica
       actually gave in a similar situation.

       We do NOT want random replica messages to become answers.
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
          p_query: cleanText(data.message),
          p_limit: 10,
        },
      ),

      supabase.rpc(
        "search_memories",
        {
          p_replica_id: data.replicaId,
          p_query: cleanText(data.message),
          p_limit: 8,
        },
      ),
    ]);

    /*
     * Retrieval errors are not immediately fatal.
     *
     * A retrieval RPC can fail while the rest of the chat system is
     * perfectly usable. We therefore keep whatever retrieval succeeded
     * and let the model use the conversation + style profile.
     */

    if (exchangeResult.error) {
      console.error(
        "[retrieval] search_similar_exchanges:",
        exchangeResult.error.message,
      );
    }

    if (replicaMessageResult.error) {
      console.error(
        "[retrieval] search_replica_messages:",
        replicaMessageResult.error.message,
      );
    }

    if (memoryResult.error) {
      console.error(
        "[retrieval] search_memories:",
        memoryResult.error.message,
      );
    }

    const similarExchanges =
      ((exchangeResult.data ?? []) as RetrievalExchange[])
        .filter(
          (row) =>
            cleanText(row.prompt_text) &&
            cleanText(row.reply_text),
        );

    const replicaMessages =
      ((replicaMessageResult.data ?? []) as RetrievedMessage[])
        .filter((row) =>
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
       9. RANK / DEDUPLICATE HISTORICAL EXCHANGES

       Never simply take the first random result.

       We prioritize:
       - high similarity
       - actual USER → REPLICA pair
       - useful response length
       - unique examples

       This is what prevents a message like:

       "What's your name"

       from being answered with some unrelated historical
       "Pidde" message just because both exist in the database.
    ================================================================= */

    const rankedExchanges = uniqueBy(
      similarExchanges,
      (row) =>
        `${cleanText(row.prompt_text)}|||${cleanText(
          row.reply_text,
        )}`,
    )
      .map((row) => {
        const similarity =
          typeof row.similarity === "number"
            ? row.similarity
            : 0;

        const promptLength =
          cleanText(row.prompt_text).length;

        const replyLength =
          cleanText(row.reply_text).length;

        /*
         * Very short historical messages are still useful, but they
         * should not dominate retrieval simply because they are short.
         */
        let qualityBonus = 0;

        if (promptLength >= 3) {
          qualityBonus += 0.02;
        }

        if (replyLength >= 2) {
          qualityBonus += 0.02;
        }

        return {
          ...row,
          retrievalScore:
            similarity + qualityBonus,
        };
      })
      .sort(
        (a, b) =>
          b.retrievalScore -
          a.retrievalScore,
      )
      .slice(0, 8);

    const uniqueReplicaMessages = uniqueBy(
      replicaMessages,
      (row) =>
        cleanText(row.message_text),
    ).slice(0, 10);

    /* ================================================================
       10. DETECT WHETHER WE HAVE A STRONG MATCH

       IMPORTANT:

       If the database doesn't have a sufficiently similar exchange,
       we should NOT pretend that a random historical answer is the
       correct answer.

       Instead, the model gets the conversation + style + memories and
       is told to answer naturally.
    ================================================================= */

    const strongestSimilarity =
      rankedExchanges.length > 0 &&
      typeof rankedExchanges[0].similarity ===
        "number"
        ? rankedExchanges[0].similarity
        : 0;

    const hasStrongHistoricalMatch =
      strongestSimilarity >= 0.45;

    const hasUsableHistoricalMatch =
      strongestSimilarity >= 0.30;

    /* ================================================================
       11. STYLE PROFILE
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
       12. BUILD HISTORICAL EVIDENCE
    ================================================================= */

    const exchangeEvidence =
      rankedExchanges.length
        ? rankedExchanges
            .map(
              (row, index) =>
                `[HISTORICAL EXCHANGE ${index + 1}]
USER MESSAGE:
${clampText(
  cleanText(row.prompt_text),
  700,
)}

ACTUAL REPLICA RESPONSE:
${clampText(
  cleanText(row.reply_text),
  700,
)}

SIMILARITY:
${
  typeof row.similarity === "number"
    ? row.similarity.toFixed(3)
    : "unknown"
}`,
            )
            .join("\n\n")
        : "NO SIMILAR HISTORICAL EXCHANGE FOUND.";

    const messageEvidence =
      uniqueReplicaMessages.length
        ? uniqueReplicaMessages
            .map(
              (row, index) =>
                `${index + 1}. ${clampText(
                  cleanText(
                    row.message_text,
                  ),
                  300,
                )}`,
            )
            .join("\n")
        : "NO ADDITIONAL REPLICA MESSAGES FOUND.";

    const memoryEvidence =
      memoryHits.length
        ? memoryHits
            .slice(0, 8)
            .map(
              (memory, index) =>
                `${index + 1}. ${
                  cleanText(memory.title) ||
                  "Memory"
                }: ${clampText(
                  cleanText(
                    memory.description,
                  ),
                  500,
                )}`,
            )
            .join("\n")
        : "NO RELEVANT MEMORIES FOUND.";

    /* ================================================================
       13. SYSTEM PROMPT
    ================================================================= */

    const systemPrompt = `
You are "${replicaName}" having a normal personal chat.

You are NOT a generic AI assistant.

Your task is to produce the ONE message that this person would most
naturally send in response to the user's CURRENT message.

==================================================
MOST IMPORTANT RULE: SITUATION → HISTORICAL RESPONSE
==================================================

The historical dataset contains real examples of:

USER MESSAGE / SITUATION
        ↓
ACTUAL REPLICA RESPONSE

Use those pairs as the strongest evidence of how this person responds.

Do NOT simply copy the user's message.

Do NOT simply select a random replica message.

Do NOT take a historical response out of context.

Instead:

1. Understand the CURRENT user's message.
2. Understand the recent conversation.
3. Determine the intent, emotion, topic and situation.
4. Look at the historical USER → REPLICA exchanges.
5. Find exchanges with the same or closely related situation.
6. Study what the replica actually replied there.
7. Adapt the closest authentic response to the CURRENT situation.
8. Preserve the person's natural language and personality.
9. Return ONE final conversational response.

==================================================
CRITICAL ANTI-COPY RULE
==================================================

NEVER return the user's current message as the replica's response.

NEVER echo the user's message merely because it appears in the
historical dataset.

For example, if the user says:

"Teri yad arhi"

and the database contains old messages where the USER said:

"Teri yad arhi"

those old USER messages are NOT replica answers.

You must use the corresponding historical REPLICA responses from those
situations.

The direction of the conversation matters:

USER → REPLICA

not:

USER → USER

==================================================
HISTORICAL MATCHING
==================================================

A historical exchange is useful when its USER MESSAGE has a similar:

- meaning
- intent
- topic
- emotional state
- conversational purpose
- question type
- request type
- teasing pattern
- affectionate pattern
- casual context

Semantic similarity alone is NOT enough.

A message should not be treated as a good match merely because it
shares one word such as:

"yad"
"pidde"
"name"
"acha"
"haan"

For example:

"What's your name?"

should not retrieve an unrelated response just because some historical
message contains "name".

Always consider the complete situation.

==================================================
WHEN THERE IS NO GOOD MATCH
==================================================

If there is no sufficiently similar historical exchange:

DO NOT force an unrelated historical response.

Instead generate a natural response using:

1. recent conversation
2. replica style profile
3. replica description
4. relevant memories
5. authentic replica wording patterns

The answer should still sound like the person.

==================================================
WHEN THERE IS A STRONG MATCH
==================================================

If a strong historical exchange exists:

Use it as the primary behavioral template.

You may reuse its wording when it naturally fits.

You may shorten it, adapt it, change names/pronouns, or adjust it to
the current context.

Do NOT blindly copy it when the current situation is different.

==================================================
CONVERSATION CONTEXT
==================================================

Recent conversation:

${recentContext || "No recent conversation available."}

The current message is:

"${cleanText(data.message)}"

The current message must always be treated as the newest user message.

==================================================
REPLICA IDENTITY
==================================================

Replica name:
${replicaName}

Replica description:
${cleanText(replica.description) || "No description available."}

==================================================
MEASURED STYLE
==================================================

${styleSummary}

==================================================
OWNER INSTRUCTIONS
==================================================

${
  cleanText(style?.custom_instructions)
    ? cleanText(style?.custom_instructions)
    : "No additional owner instructions."
}

==================================================
BEST HISTORICAL USER → REPLICA EXAMPLES
==================================================

${exchangeEvidence}

==================================================
ADDITIONAL AUTHENTIC REPLICA MESSAGES
==================================================

${messageEvidence}

==================================================
RELEVANT MEMORIES
==================================================

${memoryEvidence}

==================================================
RETRIEVAL STATUS
==================================================

Strong historical match:
${hasStrongHistoricalMatch ? "YES" : "NO"}

Usable historical match:
${hasUsableHistoricalMatch ? "YES" : "NO"}

Strongest similarity:
${strongestSimilarity.toFixed(3)}

==================================================
NATURAL CHAT RULES
==================================================

Reply like a real person texting.

Do not sound like an assistant.

Do not over-explain.

Do not automatically use complete formal sentences.

Do not repeat the user's message.

Do not answer with generic phrases.

Match the person's:

- Urdu/Hinglish/English mix
- spelling
- slang
- vocabulary
- punctuation
- capitalization
- emoji usage
- humor
- affection
- teasing
- sentence length
- response length
- conversational rhythm

If their normal response is short, be short.

If their normal response is playful, be playful.

If their normal response is teasing, tease naturally.

If the situation is serious, respond appropriately.

Do not force emojis or nicknames into every message.

==================================================
PERSONAL FACTS
==================================================

Only use facts supported by the supplied evidence.

Never invent:

- events
- memories
- relationships
- locations
- schedules
- conversations
- personal history

==================================================
FINAL OUTPUT
==================================================

Return ONLY the final message the replica would send.

No explanation.

No reasoning.

No analysis.

No labels.

No JSON.

No markdown.

No candidate responses.

No "Analysis:".

No "Reasoning:".

No <think>.

No meta commentary.

ONE FINAL CHAT MESSAGE ONLY.
`.trim();

    /* ================================================================
       14. BUILD MODEL HISTORY
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
        content: cleanText(
          data.message,
        ),
      },
    ];

    /* ================================================================
       15. OPENROUTER CONFIGURATION
    ================================================================= */

    const apiKey =
      process.env["OPENROUTER_API_KEY"];

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
       16. GENERATE FINAL RESPONSE
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
        35_000,
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

              max_tokens: 350,

              reasoning: {
                enabled: false,
                exclude: true,
              },
            }),

            signal: controller.signal,
          },
        );

        clearTimeout(timeout);

        if (response.status === 429) {
          if (attempt < attemptLimit) {
            await new Promise(
              (resolve) =>
                setTimeout(
                  resolve,
                  1000,
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
                  600,
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

        const payload =
          (await response.json()) as {
            choi        const payload =
          (await response.json()) as {
            choices?: {
              message?: {
                content?: string;
              };
            }[];

            usage?: Record<string, unknown>;

            model?: string;

            id?: string;
          };

        const rawReply =
          payload.choices?.[0]?.message?.content ?? "";

        reply = sanitizeFinalReply(rawReply);

        openRouterMeta = {
          provider: "openrouter",
          model: payload.model ?? "openrouter/free",
          request_id: payload.id ?? null,
          usage: payload.usage ?? {},
          attempt,

          retrieval: {
            similar_exchanges: rankedExchanges.length,
            strongest_similarity: strongestSimilarity,
            authentic_messages: uniqueReplicaMessages.length,
            memories: memoryHits.length,
          },
        };

        /* ------------------------------------------------------------
           EMPTY RESPONSE
        ------------------------------------------------------------ */

        if (!reply) {
          if (attempt < attemptLimit) {
            continue;
          }

          return {
            ok: false,
            reply: "",
            messageId: null,
            generatedResponseId: null,
            usedMemories: memoryHits.length,
            errorKind: "grok",
            error:
              "The AI service returned no usable response.",
          };
        }

        break;
      } catch (error) {
        clearTimeout(timeout);

        const aborted =
          error instanceof Error &&
          error.name === "AbortError";

        if (attempt < attemptLimit) {
          await new Promise((resolve) =>
            setTimeout(resolve, 500),
          );

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
       17. FINAL RESPONSE VALIDATION
    ================================================================= */

    reply = sanitizeFinalReply(reply);

    if (!reply) {
      return {
        ok: false,
        reply: "",
        messageId: null,
        generatedResponseId: null,
        usedMemories: memoryHits.length,
        errorKind: "grok",
        error: "No valid final response was generated.",
      };
    }

    /* ================================================================
       18. SAVE GENERATED RESPONSE
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
          query: data.message,

          similar_exchanges:
            rankedExchanges.length,

          strongest_similarity:
            strongestSimilarity,

          authentic_messages:
            uniqueReplicaMessages.length,

          memories: memoryHits
            .slice(0, 8)
            .map((m) => m.title),

          history: history.length,
        },

        generation_metadata: openRouterMeta,
      })
      .select("id")
      .single();

    if (generatedError) {
      console.error(
        "[database] generated_responses insert:",
        generatedError.message,
      );

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
       19. SAVE REPLICA MESSAGE
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

        generated_response_id:
          generated.id,

        reply_to_message_id:
          data.replyToMessageId ?? null,
      })
      .select("id")
      .single();

    if (storeError) {
      console.error(
        "[database] chat_session_messages insert:",
        storeError.message,
      );

      return {
        ok: false,
        reply,
        messageId: null,
        generatedResponseId:
          generated.id as string,
        usedMemories: memoryHits.length,
        errorKind: "database",
        error: storeError.message,
      };
    }

    /* ================================================================
       20. UPDATE CHAT SESSION
    ================================================================= */

    const { error: sessionUpdateError } =
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

    if (sessionUpdateError) {
      console.warn(
        "[database] chat_sessions update:",
        sessionUpdateError.message,
      );
    }

    /* ================================================================
       21. SUCCESS
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
