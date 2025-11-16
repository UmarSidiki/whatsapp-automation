import emojiRegex from "emoji-regex";
import {
  HUMAN_REPLY_PREFIX,
  PersonaExample,
  PersonaProfile,
  PersonaSource,
  USER_MESSAGE_PREFIX,
} from "../../types/persona";

const DEFAULT_EXAMPLE_LIMIT = 6;
const STATS_SAMPLE_LIMIT = 200;
const emojiPattern = emojiRegex();

const SLANG_REGEX = /\b(?:lol|lmao|bro|dude|gonna|wanna|ya|yall|ain't|aint|tho|omg|wtf|idk|btw|brb|tbh|imo|nah|sup|hiya|yo)\b/i;
const THANKS_REGEX = /\b(?:thanks?|appreciate|gracias|cheers)\b/i;
const GREETING_REGEX = /^(hi|hey|hello|hola|yo|sup)\b/i;

interface PersonaExtractionResult {
  replies: string[];
  examples: PersonaExample[];
}

interface BuildProfileArgs {
  source: PersonaSource;
  replies: string[];
  examples: PersonaExample[];
  exampleLimit?: number;
}

interface ReplyStats {
  sampleSize: number;
  avgWords: number;
  avgChars: number;
  emojiMessageRatio: number;
  emojiPerMessage: number;
  questionRatio: number;
  exclaimRatio: number;
  slangRatio: number;
  thanksRatio: number;
  greetingRatio: number;
  topEmojis: string[];
}

function clean(text: string | undefined | null): string {
  return typeof text === "string" ? text.trim() : "";
}

export function extractContactPersonaData(
  messages: { message: string }[],
  exampleLimit: number = DEFAULT_EXAMPLE_LIMIT
): PersonaExtractionResult {
  if (!Array.isArray(messages) || !messages.length) {
    return { replies: [], examples: [] };
  }

  const trimmed = messages.slice(-Math.max(exampleLimit * 6, 60));
  const replies: string[] = [];
  const examples: PersonaExample[] = [];
  const pendingUser: string[] = [];

  for (const record of trimmed) {
    const raw = clean(record.message);
    if (!raw) continue;

    if (raw.startsWith(USER_MESSAGE_PREFIX)) {
      const userText = clean(raw.slice(USER_MESSAGE_PREFIX.length));
      if (userText) {
        pendingUser.push(userText);
        if (pendingUser.length > 3) {
          pendingUser.shift();
        }
      }
      continue;
    }

    if (raw.startsWith(HUMAN_REPLY_PREFIX)) {
      const replyText = clean(raw.slice(HUMAN_REPLY_PREFIX.length));
      if (!replyText) continue;
      replies.push(replyText);

      if (pendingUser.length) {
        const userText = pendingUser.join(" / ");
        examples.push({ user: userText, reply: replyText });
        pendingUser.length = 0;
      } else {
        examples.push({ reply: replyText });
      }
    }
  }

  return {
    replies: replies.slice(-STATS_SAMPLE_LIMIT),
    examples: examples.slice(-exampleLimit),
  };
}

export function buildStandaloneExamples(
  replies: string[],
  exampleLimit: number = DEFAULT_EXAMPLE_LIMIT
): PersonaExample[] {
  if (!Array.isArray(replies)) return [];
  return replies
    .map((reply) => clean(reply))
    .filter(Boolean)
    .slice(-exampleLimit)
    .map((reply) => ({ reply }));
}

export function buildPersonaProfile({
  source,
  replies,
  examples,
  exampleLimit = DEFAULT_EXAMPLE_LIMIT,
}: BuildProfileArgs): PersonaProfile {
  const trimmedReplies = Array.isArray(replies)
    ? replies.map((reply) => clean(reply)).filter(Boolean)
    : [];
  const trimmedExamples = Array.isArray(examples)
    ? examples
        .map((example) => ({
          user: clean(example.user),
          reply: clean(example.reply),
        }))
        .filter((example) => Boolean(example.reply))
        .slice(-exampleLimit)
    : [];

  if (!trimmedReplies.length) {
    return {
      source: "bootstrap",
      summary:
        "No owner-written replies captured yet. Default to a calm, friendly professional tone with one or two concise sentences.",
      guidelines: [
        "Respond strictly as the human owner; never mention automation or AI.",
        "Keep messages short, factual, and focused on next steps.",
        "Ask for clarification whenever the request is vague or missing details.",
        "Use emojis only when the user does first or when you need extra warmth.",
        "Do not reuse wording from past chats; write original sentences.",
      ],
      examples: trimmedExamples,
    };
  }

  const stats = analyzeReplies(trimmedReplies);
  const summary = composeSummary(stats);
  const guidelines = composeGuidelines(stats);

  return {
    source,
    summary,
    guidelines,
    examples: trimmedExamples,
  };
}

function analyzeReplies(replies: string[]): ReplyStats {
  const sample = replies.slice(-STATS_SAMPLE_LIMIT);
  const sampleSize = sample.length;
  if (!sampleSize) {
    return {
      sampleSize: 0,
      avgWords: 0,
      avgChars: 0,
      emojiMessageRatio: 0,
      emojiPerMessage: 0,
      questionRatio: 0,
      exclaimRatio: 0,
      slangRatio: 0,
      thanksRatio: 0,
      greetingRatio: 0,
      topEmojis: [],
    };
  }

  let totalWords = 0;
  let totalChars = 0;
  let emojiMessages = 0;
  let emojiTotal = 0;
  let questionMessages = 0;
  let exclaimMessages = 0;
  let slangMessages = 0;
  let thanksMessages = 0;
  let greetingMessages = 0;

  const emojiCounts = new Map<string, number>();

  for (const reply of sample) {
    const words = reply.split(/\s+/).filter(Boolean);
    totalWords += words.length;
    totalChars += reply.length;

    const emojis = reply.match(emojiPattern) || [];
    if (emojis.length) {
      emojiMessages += 1;
      emojiTotal += emojis.length;
      for (const emoji of emojis) {
        emojiCounts.set(emoji, (emojiCounts.get(emoji) || 0) + 1);
      }
    }

    if (reply.includes("?")) {
      questionMessages += 1;
    }
    if (reply.includes("!")) {
      exclaimMessages += 1;
    }

    const lower = reply.toLowerCase();
    if (SLANG_REGEX.test(lower)) {
      slangMessages += 1;
    }
    if (THANKS_REGEX.test(lower)) {
      thanksMessages += 1;
    }
    if (GREETING_REGEX.test(lower.trim())) {
      greetingMessages += 1;
    }
  }

  const topEmojis = Array.from(emojiCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([emoji]) => emoji);

  return {
    sampleSize,
    avgWords: Math.max(1, Math.round(totalWords / sampleSize)),
    avgChars: Math.max(1, Math.round(totalChars / sampleSize)),
    emojiMessageRatio: emojiMessages / sampleSize,
    emojiPerMessage: emojiTotal / sampleSize,
    questionRatio: questionMessages / sampleSize,
    exclaimRatio: exclaimMessages / sampleSize,
    slangRatio: slangMessages / sampleSize,
    thanksRatio: thanksMessages / sampleSize,
    greetingRatio: greetingMessages / sampleSize,
    topEmojis,
  };
}

function composeSummary(stats: ReplyStats): string {
  const parts: string[] = [];

  if (stats.avgWords <= 10) {
    parts.push(`Prefers crisp replies of roughly ${stats.avgWords} words.`);
  } else if (stats.avgWords <= 20) {
    parts.push(`Writes balanced answers (~${stats.avgWords} words) mixing warmth and direction.`);
  } else {
    parts.push(`Usually sends detailed replies (~${stats.avgWords} words) with added context.`);
  }

  if (stats.emojiMessageRatio >= 0.6) {
    const list = formatEmojiList(stats.topEmojis);
    parts.push(`Uses emojis in most messages (${list}); match that energy without overusing them.`);
  } else if (stats.emojiMessageRatio >= 0.3) {
    const list = formatEmojiList(stats.topEmojis);
    parts.push(`Sprinkles emojis occasionally (${list}) when warmth helps.`);
  } else {
    parts.push("Rarely adds emojis, so keep text clean unless the user adds one first.");
  }

  if (stats.questionRatio >= 0.35) {
    parts.push("Often ends with a question or prompt to keep the chat moving.");
  } else {
    parts.push("Leans on confident statements more than back-to-back questions.");
  }

  if (stats.exclaimRatio >= 0.4) {
    parts.push("Tone is upbeat with frequent exclamation marks - keep it enthusiastic when appropriate.");
  } else {
    parts.push("Tone stays measured; exclamation marks are used sparingly.");
  }

  if (stats.slangRatio >= 0.25) {
    parts.push("Comfortable using casual slang and shorthand when the relationship allows.");
  } else {
    parts.push("Prefers clear, professional wording over heavy slang.");
  }

  if (stats.thanksRatio >= 0.25) {
    parts.push("Often closes with gratitude or encouragement.");
  }

  if (stats.greetingRatio >= 0.25) {
    parts.push("Frequently starts with a light greeting before addressing the ask.");
  }

  return parts.join(" ");
}

function composeGuidelines(stats: ReplyStats): string[] {
  const guidelines: string[] = [];

  guidelines.push("Act as the human account owner; never mention automation or AI.");
  guidelines.push("Mirror the tone described in the style profile without copying sentences from history.");

  if (stats.avgWords <= 12) {
    guidelines.push("Stay punchy: one or two short sentences are enough.");
  } else if (stats.avgWords >= 30) {
    guidelines.push("Offer fuller replies (2-3 sentences) with concrete next steps.");
  } else {
    guidelines.push("Keep responses to about two sentences mixing empathy with direction.");
  }

  if (stats.emojiMessageRatio >= 0.5) {
    guidelines.push("Include at most one emoji when it adds warmth; skip them if the conversation is serious.");
  } else {
    guidelines.push("Only add an emoji when the user uses one first or when extra warmth is needed.");
  }

  if (stats.questionRatio >= 0.35) {
    guidelines.push("End with a clarifying or forward-looking question when it keeps momentum.");
  } else {
    guidelines.push("Close with a confident statement unless you truly need more info.");
  }

  if (stats.slangRatio >= 0.25) {
    guidelines.push("Casual slang is fine—keep it respectful and modern.");
  } else {
    guidelines.push("Favor clear, professional wording over slang.");
  }

  guidelines.push("If details are missing, ask for them instead of guessing or inventing capabilities.");

  return guidelines;
}

function formatEmojiList(list: string[]): string {
  if (!list.length) {
    return "select emojis";
  }
  return list.join(", ");
}
