import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * SERVER-ONLY retrieval + response hygiene for replica generation.
 *
 * The pipeline is evidence-first:
 *
 *   current user message
 *     -> recent conversation context (bounded window)
 *     -> similar HISTORICAL USER messages   (search_similar_exchanges)
 *     -> the ACTUAL replica reply that followed each of them (paired)
 *     -> re-rank by intent / situation / context / authenticity
 *     -> small, high-quality evidence set handed to the model
 *
 * Nothing here loads the whole dataset: every read is an indexed, bounded
 * database call and ranking happens over at most a few dozen rows.
 */

export type Exchange = {
  promptText: string;
  replyText: string;
  similarity: number;
  contextSimilarity: number;
  score: number;
};

export type RetrievalBundle = {
  exchanges: Exchange[];
  frequentLines: string[];
  memories: { title: string | null; description: string | null }[];
  contextText: string;
  newTopic: boolean;
};

const STOP = new Set([
  "the","a","an","and","or","but","if","to","of","in","on","at","for","is","are","was","were",
  "i","you","he","she","it","we","they","me","my","your","this","that","be","do","did","not",
  "so","just","no","yes","ok","okay","with","have","has","had","will","would","can","could",
  "hai","ho","hu","hun","na","ne","ka","ki","ke","ko","se","mein","me",
]);

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(text: string): string[] {
  return normalize(text).split(" ").filter((word) => word.length > 1);
}

function contentTokens(text: string): Set<string> {
  return new Set(tokens(text).filter((word) => !STOP.has(word)));
}

/** Jaccard overlap over content words — cheap intent-similarity proxy. */
export function overlap(a: string, b: string): number {
  const left = contentTokens(a);
  const right = contentTokens(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

const QUESTION_WORDS = [
  "what","who","where","when","why","how","which","kya","kaun","kahan","kab","kyu","kyun","kaise","kitna",
];

export function isQuestion(text: string): boolean {
  const words = tokens(text);
  return text.includes("?") || words.some((word) => QUESTION_WORDS.includes(word));
}

/**
 * Retrieve everything needed for one reply, in parallel and bounded.
 */
export async function retrieveEvidence(
  supabase: SupabaseClient,
  params: {
    replicaId: string;
    message: string;
    history: { sender_role: string; message_text: string | null }[];
  },
): Promise<RetrievalBundle> {
  const { replicaId, message } = params;

  // Bounded recent context: the last few turns only, so a stale topic cannot
  // dominate retrieval for a brand-new question.
  const recent = params.history
    .filter((row) => (row.message_text ?? "").trim())
    .slice(-6);
  const contextText = recent
    .slice(-4)
    .map((row) => row.message_text!.trim())
    .join(" \n ");

  const lastUser = [...recent].reverse().find((row) => row.sender_role !== "replica");
  const topicShift =
    !lastUser ||
    (overlap(lastUser.message_text ?? "", message) < 0.12 && isQuestion(message));

  const keywords = tokens(message)
    .filter((word) => word.length > 3 && !STOP.has(word))
    .slice(0, 4);

  const [exchangeRes, frequentRes, memoryRes] = await Promise.all([
    supabase.rpc("search_similar_exchanges", {
      p_replica_id: replicaId,
      p_query: message,
      p_limit: 24,
      // On a topic change, do not let the previous topic bias retrieval.
      p_context: topicShift ? "" : contextText,
    }),
    supabase.rpc("replica_frequent_lines", { p_replica_id: replicaId, p_limit: 24 }),
    keywords.length
      ? supabase
          .from("memory_items")
          .select("title, description")
          .eq("replica_id", replicaId)
          .or(keywords.map((word) => `description.ilike.%${word}%`).join(","))
          .limit(6)
      : supabase
          .from("memory_items")
          .select("title, description")
          .eq("replica_id", replicaId)
          .order("created_at", { ascending: false })
          .limit(4),
  ]);

  const rawExchanges = (exchangeRes.data ?? []) as {
    prompt_text: string | null;
    reply_text: string | null;
    similarity: number | null;
    context_similarity: number | null;
  }[];

  const seen = new Set<string>();
  const exchanges: Exchange[] = [];

  for (const row of rawExchanges) {
    const promptText = (row.prompt_text ?? "").trim();
    const replyText = (row.reply_text ?? "").trim();
    if (!promptText || !replyText) continue;

    // A "reply" that just echoes the historical prompt is not evidence of
    // behaviour — it is a parsing artefact. Drop it.
    if (overlap(promptText, replyText) > 0.75) continue;

    const key = normalize(replyText);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const similarity = Number(row.similarity ?? 0);
    const contextSimilarity = Number(row.context_similarity ?? 0);
    const intent = overlap(promptText, message);
    const sameShape = isQuestion(promptText) === isQuestion(message) ? 0.12 : 0;

    // Situation similarity dominates: how close is the HISTORICAL user
    // situation to the CURRENT one, given the current conversation.
    const score =
      similarity * 0.4 + intent * 0.34 + (topicShift ? 0 : contextSimilarity * 0.14) + sameShape;

    exchanges.push({ promptText, replyText, similarity, contextSimilarity, score });
  }

  exchanges.sort((a, b) => b.score - a.score);

  const frequentLines = ((frequentRes.data ?? []) as { message_text: string | null }[])
    .map((row) => (row.message_text ?? "").trim())
    .filter(Boolean)
    .slice(0, 18);

  const memories = ((memoryRes.data ?? []) as {
    title: string | null;
    description: string | null;
  }[]).slice(0, 5);

  return {
    exchanges: exchanges.slice(0, 8),
    frequentLines,
    memories,
    contextText,
    newTopic: topicShift,
  };
}

/** Remove any chain-of-thought / meta wrapper a model may emit. */
export function sanitizeReply(raw: string): string {
  let text = raw ?? "";

  text = text.replace(/<(think|thinking|reasoning|scratchpad|analysis)[\s\S]*?<\/\1>/gi, " ");
  // Unterminated opening tag: drop everything before the last one.
  text = text.replace(/[\s\S]*<\/(?:think|thinking|reasoning|analysis)>/gi, " ");
  text = text.replace(/^\s*<(?:think|thinking|reasoning|analysis)>[\s\S]*$/gi, " ");
  text = text.replace(
    /^\s*(?:reasoning|analysis|thought process|thoughts|internal|explanation|note)\s*:.*$/gim,
    " ",
  );
  text = text.replace(/^\s*(?:final\s+)?(?:answer|reply|response)\s*:\s*/gim, "");
  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/\s+/g, " ").trim();

  // Models sometimes wrap the whole line in quotes.
  const quoted = text.match(/^["“”'](.+)["“”']$/s);
  if (quoted?.[1]) text = quoted[1].trim();

  // Keep only the first conversational turn if the model listed options.
  text = text.replace(/^\s*[-*\d.)]+\s*/, "").trim();

  return text;
}

/** True when the reply is effectively a copy of what the user just said. */
export function echoesUser(reply: string, userMessage: string): boolean {
  const a = normalize(reply);
  const b = normalize(userMessage);
  if (!a) return true;
  if (a === b) return true;
  if (b.length > 3 && (a.startsWith(b) || b.startsWith(a))) return true;
  return overlap(reply, userMessage) >= 0.8;
}

/**
 * Last-resort, still-authentic reply: the historical response the replica
 * actually gave in the most similar situation, provided it is not an echo.
 */
export function fallbackFromEvidence(
  bundle: RetrievalBundle,
  userMessage: string,
): string | null {
  for (const exchange of bundle.exchanges) {
    if (!echoesUser(exchange.replyText, userMessage)) return exchange.replyText;
  }
  for (const line of bundle.frequentLines) {
    if (!echoesUser(line, userMessage)) return line;
  }
  return null;
}

export function buildEvidencePrompt(bundle: RetrievalBundle): string {
  const parts: string[] = [];

  if (bundle.exchanges.length) {
    parts.push(
      [
        "PRIMARY EVIDENCE — real past exchanges from this person's own conversations.",
        'Each pair is: what the other person said, then what THEY actually replied.',
        "Find the pair whose situation matches the current message best, then adapt that behaviour.",
        "Never reuse the OTHER PERSON's line as your reply.",
        ...bundle.exchanges.map(
          (exchange, index) =>
            `${index + 1}. THEM(other): "${exchange.promptText.slice(0, 220)}"\n   REPLICA replied: "${exchange.replyText.slice(0, 220)}"`,
        ),
      ].join("\n"),
    );
  }

  if (bundle.frequentLines.length) {
    parts.push(
      `Wording they genuinely use often (prefer this vocabulary over invented phrasing):\n${bundle.frequentLines
        .map((line) => `- ${line}`)
        .join("\n")}`,
    );
  }

  if (bundle.memories.length) {
    parts.push(
      `Factual memories (context only — they must not dictate wording):\n${bundle.memories
        .map((memory) => `- ${memory.title ?? "memory"}: ${(memory.description ?? "").slice(0, 300)}`)
        .join("\n")}`,
    );
  }

  if (bundle.newTopic) {
    parts.push(
      "The latest message starts a NEW topic or asks a new question. Answer that, do not continue the previous topic.",
    );
  }

  return parts.join("\n\n");
}
