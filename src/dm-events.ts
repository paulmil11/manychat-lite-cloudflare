import { parseReplyPayload, type StoryRule } from "./dm-features";
import { isBasicallyKeyword } from "./keyword-match";

// Parses the Instagram messaging webhooks (messages, messaging_postbacks and
// messaging_referral) into one event shape.
export type DmEvent = {
  messageId: string;
  senderId: string;
  recipientId: string | null;
  text: string;
  quickReplyPayload: string | null;
  timestamp: number | null;
  kind: "message" | "postback" | "referral";
  source: "dm" | "starter" | "postback" | "story_reply" | "story_mention" | "referral";
  storyId: string | null;
  storyUrl: string | null;
  storyLinkUrl: string | null;
  referralRef: string | null;
};

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}
function string(value: unknown, max = 10000): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}
function httpsUrl(value: unknown): string | null {
  const text = string(value, 4000);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Only real incoming messages, postbacks and documented ig.me link opens can cause replies. */
export async function extractDmEvents(payload: unknown): Promise<DmEvent[]> {
  const data = record(payload);
  if (data?.object !== "instagram" || !Array.isArray(data.entry)) return [];
  const parsed: DmEvent[] = [];
  for (const entryValue of data.entry) {
    const entry = record(entryValue);
    if (!entry) continue;
    const candidates: unknown[] = Array.isArray(entry.messaging) ? [...entry.messaging] : [];
    if (Array.isArray(entry.changes)) {
      for (const changeValue of entry.changes) {
        const change = record(changeValue);
        if (change && ["messages", "messaging_postbacks", "messaging_referral"].includes(String(change.field))) {
          candidates.push(change.value);
        }
      }
    }
    for (const value of candidates) {
      const event = await parseDmEvent(value, string(entry.id, 256));
      if (event) parsed.push(event);
    }
  }
  return parsed;
}

async function parseDmEvent(input: unknown, entryId: string | null): Promise<DmEvent | null> {
  const value = record(input);
  if (!value) return null;
  const message = record(value.message);
  const postback = record(value.postback);
  // Changes-style messages can expose their fields directly on value.
  const legacyMessage = !message && !postback && (value.text || value.quick_reply) ? value : null;
  const content = message ?? legacyMessage;
  // Echoes are the account's own outgoing messages.
  if (value.is_echo === true || content?.is_echo === true || content?.is_deleted === true ||
      content?.is_unsupported === true || value.is_deleted === true) return null;
  const sender = record(value.sender) ?? record(value.from);
  const senderId = string(sender?.id, 256) ?? string(value.sender_id, 256);
  const recipientId = string(record(value.recipient)?.id, 256) ?? string(value.recipient_id, 256) ?? entryId;
  if (!senderId) return null;
  const possibleReferral = record(postback?.referral) ?? record(content?.referral) ?? record(value.referral);
  const referral = possibleReferral?.source === "SHORTLINKS" && possibleReferral.type === "OPEN_THREAD"
    ? possibleReferral : null;
  const referralRef = string(referral?.ref, 2083);
  const kind = postback ? "postback" : content ? "message" : referralRef ? "referral" : null;
  if (!kind) return null;
  const quickReplyPayload = string(postback?.payload, 1000) ??
    string(record(content?.quick_reply)?.payload, 1000) ?? string(content?.payload, 1000);
  const text = string(content?.text) ?? string(postback?.title, 1000) ?? "";
  const story = record(record(content?.reply_to)?.story);
  const storyId = string(story?.id, 256);
  const attachments = Array.isArray(content?.attachments) ? content.attachments : [];
  const mention = attachments.map(record).find((attachment) => attachment?.type === "story_mention");
  const storyUrl = httpsUrl(story?.url) ?? httpsUrl(record(mention?.payload)?.url);
  const storyLinkUrl = httpsUrl(story?.link_sticker_url);
  if (!text && !quickReplyPayload && !referralRef && !storyId && !storyUrl && !mention) return null;
  const timestampValue = value.timestamp ?? content?.timestamp;
  const timestamp = typeof timestampValue === "number" && Number.isFinite(timestampValue) && timestampValue > 0
    ? timestampValue : null;
  const source: DmEvent["source"] = story ? "story_reply" : mention ? "story_mention" :
    postback ? parseReplyPayload(quickReplyPayload) ? "starter" : "postback" : referralRef ? "referral" : "dm";
  let messageId = string(content?.mid, 1000) ?? string(content?.id, 1000) ??
    string(postback?.mid, 1000) ?? string(value.mid, 1000);
  if (!messageId) {
    // Postbacks and link opens may arrive without an ID. Hash the event so duplicates still dedupe.
    const identity = JSON.stringify([entryId, senderId, recipientId, timestamp, kind, quickReplyPayload, referralRef, storyId, storyUrl, text]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
    messageId = `event:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  return { messageId, senderId, recipientId, text, quickReplyPayload, timestamp, kind, source, storyId, storyUrl, storyLinkUrl, referralRef };
}

export function matchStoryRule(event: DmEvent, rules: StoryRule[]): StoryRule | null {
  if (event.source !== "story_reply" && event.source !== "story_mention") return null;
  // A specific story wins over a keyword applying to every story. Paused matching
  // rules remain selected so a generic keyword cannot bypass the pause.
  const ordered = [...rules].sort((a, b) => Number(Boolean(b.storyId || b.storyUrl)) - Number(Boolean(a.storyId || a.storyUrl)));
  for (const rule of ordered) {
    if (!rule.storyId && !rule.storyUrl && !rule.keyword) continue;
    if (rule.storyId && rule.storyId !== event.storyId) continue;
    if (rule.storyUrl && ![event.storyUrl, event.storyLinkUrl].includes(httpsUrl(rule.storyUrl))) continue;
    // Story rule keywords follow the same rule as automations (src/keyword-match.ts).
    if (rule.keyword && !isBasicallyKeyword(event.text, rule.keyword)) continue;
    return rule;
  }
  return null;
}
