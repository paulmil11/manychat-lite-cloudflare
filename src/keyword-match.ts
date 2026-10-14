export type KeywordMatch = { match: boolean; reason: "match" | "missing" | "too_long" | "extra_words" };

/**
 * A comment, DM or story reply triggers an automation only when it is basically
 * just the keyword: the keyword as whole words (underscores count as word
 * characters), plus at most one other word, in eight words or fewer. Request
 * words like "please" or "send me the link" don't count, and @mentions are
 * ignored, so "@yourhandle I like your thinking on this" doesn't match
 * YOURHANDLE, and "What are your favorite books on personal finance?" doesn't
 * match BOOKS.
 *
 * Keep this function self-contained: the New automation form embeds its source
 * so the message tester in the browser runs exactly the same rule.
 */
export function keywordMatch(text: string, keyword: string): KeywordMatch {
  const requestWords = new Set([
    "a", "an", "the", "my", "me", "i", "you", "it", "to", "for", "of", "and", "or",
    "please", "pls", "plz", "send", "get", "can", "could", "would", "want", "need",
    "link", "links", "info", "dm", "dms", "here", "now", "yes", "yeah", "yep", "ok", "okay",
    "hi", "hey", "hello", "thanks", "thank", "thx", "ty", "copy", "version",
  ]);
  const words = (value: string) => value.normalize("NFKC").toLowerCase()
    .replace(/@[\p{L}\p{N}._]+/gu, " ")
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);
  const keywordWords = words(keyword);
  const textWords = words(text);
  const start = keywordWords.length ? textWords.findIndex((_, index) =>
    keywordWords.every((word, offset) => textWords[index + offset] === word)) : -1;
  if (start < 0) return { match: false, reason: "missing" };
  if (textWords.length > 8) return { match: false, reason: "too_long" };
  const rest = [...textWords.slice(0, start), ...textWords.slice(start + keywordWords.length)];
  const otherWords = rest.filter(word => !requestWords.has(word) && !keywordWords.includes(word));
  return otherWords.length <= 1 ? { match: true, reason: "match" } : { match: false, reason: "extra_words" };
}

export function isBasicallyKeyword(text: string, keyword: string): boolean {
  return keywordMatch(text, keyword).match;
}
