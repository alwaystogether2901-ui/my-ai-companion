import type { ParsedMessage } from "./parsers";

export type StyleProfile = {
  language_profile: Record<string, unknown>;
  humor_profile: Record<string, unknown>;
  emoji_profile: Record<string, unknown>;
  punctuation_profile: Record<string, unknown>;
  vocabulary_profile: Record<string, unknown>;
  response_length_profile: Record<string, unknown>;
  greeting_profile: Record<string, unknown>;
  personality_profile: Record<string, unknown>;
};

const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F0FF}]/gu;
const GREETINGS = [
  "hi", "hey", "hello", "yo", "salam", "assalam", "assalamualaikum", "morning",
  "good morning", "good night", "gn", "gm", "hola", "sup", "heyy",
];
const LAUGHS = ["haha", "hahaha", "lol", "lmao", "rofl", "hehe", "😂", "🤣", "😅"];
const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","to","of","in","on","at","for","is","are","was","were",
  "i","you","he","she","it","we","they","me","my","your","this","that","be","do","did","not",
  "so","just","no","yes","ok","okay","with","have","has","had","will","would","can","could",
]);

export function analyzeStyle(messages: ParsedMessage[]): StyleProfile {
  const texts = messages.map((m) => m.text ?? "").filter(Boolean);
  const total = Math.max(texts.length, 1);
  const joined = texts.join(" ").toLowerCase();

  const emojiMatches = joined.match(EMOJI_REGEX) ?? [];
  const emojiCounts = new Map<string, number>();
  for (const emoji of emojiMatches) emojiCounts.set(emoji, (emojiCounts.get(emoji) ?? 0) + 1);
  const topEmojis = [...emojiCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

  const wordCounts = new Map<string, number>();
  const phraseCounts = new Map<string, number>();
  let wordTotal = 0;
  for (const text of texts) {
    const words = text.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, " ").split(/\s+/).filter(Boolean);
    wordTotal += words.length;
    words.forEach((word) => {
      if (word.length > 2 && !STOPWORDS.has(word)) {
        wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
      }
    });
    for (let i = 0; i < words.length - 1; i += 1) {
      const phrase = `${words[i]} ${words[i + 1]}`;
      phraseCounts.set(phrase, (phraseCounts.get(phrase) ?? 0) + 1);
    }
  }

  const lengths = texts.map((t) => t.split(/\s+/).filter(Boolean).length).sort((a, b) => a - b);
  const avgWords = wordTotal / total;
  const median = lengths.length ? lengths[Math.floor(lengths.length / 2)]! : 0;

  const exclamations = texts.filter((t) => t.includes("!")).length;
  const questions = texts.filter((t) => t.includes("?")).length;
  const ellipses = texts.filter((t) => t.includes("...")).length;
  const allCaps = texts.filter((t) => t.length > 3 && t === t.toUpperCase() && /[A-Z]/.test(t)).length;
  const noPunctuation = texts.filter((t) => !/[.!?]$/.test(t.trim())).length;

  const laughCount = LAUGHS.reduce((sum, token) => sum + (joined.split(token).length - 1), 0);
  const greetingHits = GREETINGS.map((g) => ({
    greeting: g,
    count: texts.filter((t) => t.toLowerCase().trim().startsWith(g)).length,
  }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  const latinRatio = (joined.match(/[a-z]/g) ?? []).length / Math.max(joined.length, 1);
  const nonLatin = joined.match(/[\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\u0400-\u04FF]/g) ?? [];
  const romanUrduHits = ["kya", "nahi", "acha", "bhai", "yaar", "theek", "hai", "kar", "matlab"].filter(
    (token) => joined.includes(token),
  );

  return {
    language_profile: {
      dominant_script: nonLatin.length > joined.length * 0.1 ? "non-latin" : "latin",
      latin_ratio: Number(latinRatio.toFixed(3)),
      roman_urdu_markers: romanUrduHits,
      code_switching: romanUrduHits.length >= 3,
      sample_lines: texts.slice(0, 5),
    },
    humor_profile: {
      laugh_tokens_per_100_messages: Number(((laughCount / total) * 100).toFixed(1)),
      playful: laughCount / total > 0.15,
      sarcasm_markers: (joined.match(/\b(yeah right|sure sure|obviously)\b/g) ?? []).length,
    },
    emoji_profile: {
      emojis_per_message: Number((emojiMatches.length / total).toFixed(2)),
      uses_emojis: emojiMatches.length > total * 0.05,
      top_emojis: topEmojis.map(([emoji, count]) => ({ emoji, count })),
    },
    punctuation_profile: {
      exclamation_ratio: Number((exclamations / total).toFixed(3)),
      question_ratio: Number((questions / total).toFixed(3)),
      ellipsis_ratio: Number((ellipses / total).toFixed(3)),
      all_caps_ratio: Number((allCaps / total).toFixed(3)),
      often_skips_end_punctuation: noPunctuation / total > 0.6,
    },
    vocabulary_profile: {
      unique_words: wordCounts.size,
      top_words: [...wordCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([word, count]) => ({ word, count })),
      signature_phrases: [...phraseCounts.entries()]
        .filter(([, count]) => count > 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([phrase, count]) => ({ phrase, count })),
    },
    response_length_profile: {
      average_words: Number(avgWords.toFixed(2)),
      median_words: median,
      short_reply_ratio: Number((lengths.filter((l) => l <= 3).length / total).toFixed(3)),
      long_reply_ratio: Number((lengths.filter((l) => l > 30).length / total).toFixed(3)),
      style: avgWords < 6 ? "terse" : avgWords < 18 ? "conversational" : "expansive",
    },
    greeting_profile: {
      common_greetings: greetingHits,
      preferred_greeting: greetingHits[0]?.greeting ?? null,
    },
    personality_profile: {
      message_sample: texts.slice(0, 40),
      warmth: exclamations / total > 0.2 ? "high" : "moderate",
      curiosity: questions / total > 0.2 ? "high" : "moderate",
      analyzed_messages: texts.length,
    },
  };
}
