import { getInstagramAccessToken } from "./instagram-token";

// DM tools: conversation starters, story replies, links to specific replies and
// follower checks. Whether keyword automations answer DMs and story replies is
// set per automation (rules.channels), not here. Each tool points at a reply key:
//   rule-<id>  sends the DM text and link button of that keyword rule
//   text-<id>  sends one of the custom text replies saved in DM tools
export type ReplyKey = string;
export type ReplyTarget = { type: "rule"; ruleId: number } | { type: "text"; textId: string };

export type CustomReply = { id: string; label: string; text: string };
export type DmStarter = { title: string; reply: ReplyKey };
export type StoryRule = {
  id: string;
  label: string;
  storyId: string;
  storyUrl: string;
  keyword: string;
  reply: ReplyKey;
  enabled: boolean;
};
export type DmFeatureSettings = {
  startersEnabled: boolean;
  starters: DmStarter[];
  followerCheckEnabled: boolean;
  followerReply: string;
  nonFollowerReply: string;
  customReplies: CustomReply[];
  storyRules: StoryRule[];
};
export type IceBreakersPublicationStatus = {
  state: "not_published" | "pending" | "synced" | "error";
  error: string | null;
  syncedAt: string | null;
};
export type InstagramProfile = {
  username: string | null;
  isFollower: boolean | null;
  checkedAt: string | null;
  error: string | null;
};
export type InstagramIceBreakersResult = {
  starters: Array<{ title: string; payload: string; reply: ReplyKey | null }>;
  error: string | null;
};

type FeatureEnv = Pick<Cloudflare.Env, "DB"> & {
  INSTAGRAM_ACCESS_TOKEN: string;
  IG_USER_ID: string;
  GRAPH_API_BASE: string;
};
type Parsed<T> = { ok: true; settings: T } | { ok: false; error: string };
type ProfileRow = { username: string | null; is_follower: number | null; checked_at: number; expires_at: number; safe_error: string | null };
type PublicationRecord = IceBreakersPublicationStatus & { settingsHash: string | null; leaseOwner: string | null; leaseUntil: number };

const DAY = 24 * 60 * 60 * 1000;
const PROFILE_FAILURE_TTL = 5 * 60 * 1000;
const REQUEST_TIMEOUT = 10000;
const MAX_JSON_BYTES = 64 * 1024;
const PUBLICATION_KEY = "icebreakers_publish";
export const MAX_STARTERS = 4;
export const MAX_STORY_RULES = 30;
export const MAX_CUSTOM_REPLIES = 10;
export const MAX_GREETING_LENGTH = 80;
export const MAX_CUSTOM_REPLY_LENGTH = 1000;

const REPLY_KEY_PATTERN = "(?:rule-[1-9][0-9]{0,9}|text-[a-z0-9]{1,24})";
const REPLY_KEY = new RegExp(`^${REPLY_KEY_PATTERN}$`);
const REPLY_PAYLOAD = new RegExp(`^DM_REPLY__(${REPLY_KEY_PATTERN})$`);
const REPLY_REF = new RegExp(`^(${REPLY_KEY_PATTERN})(?:__([A-Za-z0-9_-]{1,80}))?$`);
const LINK_SOURCE = /^[A-Za-z0-9_-]{1,80}$/;
const INSTAGRAM_USERNAME = /^[A-Za-z0-9._]{1,30}$/;

// New installs start with everything off and one example custom reply.
export const DEFAULT_DM_FEATURE_SETTINGS: DmFeatureSettings = {
  startersEnabled: false,
  starters: [],
  followerCheckEnabled: false,
  followerReply: "",
  nonFollowerReply: "",
  customReplies: [
    { id: "ask", label: "Ask a question", text: "Thanks for reaching out! Send your question here and I will reply as soon as I can." }
  ],
  storyRules: []
};

export function ruleReplyKey(ruleId: number): ReplyKey {
  return `rule-${ruleId}`;
}

export function customReplyKey(textId: string): ReplyKey {
  return `text-${textId}`;
}

export function parseReplyKey(value: string | null | undefined): ReplyTarget | null {
  if (!value || !REPLY_KEY.test(value)) return null;
  return value.startsWith("rule-")
    ? { type: "rule", ruleId: Number(value.slice("rule-".length)) }
    : { type: "text", textId: value.slice("text-".length) };
}

export function isReplyKey(value: unknown): value is ReplyKey {
  return typeof value === "string" && REPLY_KEY.test(value);
}

/** Postback payload sent by Instagram when someone taps a conversation starter. */
export function buildReplyPayload(reply: ReplyKey): string {
  return `DM_REPLY__${reply}`;
}

export function parseReplyPayload(value: string | null | undefined): ReplyKey | null {
  return REPLY_PAYLOAD.exec(value ?? "")?.[1] ?? null;
}

/** ig.me referral: ref=<reply key>__<source>, for example rule-3__newsletter. */
export function parseReplyRef(value: string | null | undefined): { reply: ReplyKey; source: string | null } | null {
  const match = REPLY_REF.exec(value ?? "");
  return match ? { reply: match[1], source: match[2] ?? null } : null;
}

export function buildReplyLink(username: string, reply: ReplyKey, source = "website"): string {
  const handle = username.replace(/^@/, "").trim();
  if (!INSTAGRAM_USERNAME.test(handle) || !isReplyKey(reply) || !LINK_SOURCE.test(source)) return "";
  return `https://ig.me/${handle}?ref=${reply}__${source}`;
}

function validHttpsUrl(value: string): boolean {
  if (value.length > 2000) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

/** A reply key is usable when it names an existing rule or custom reply. */
function knownReply(reply: ReplyKey, customReplies: CustomReply[], ruleIds?: ReadonlySet<number>): boolean {
  const target = parseReplyKey(reply);
  if (!target) return false;
  if (target.type === "text") return customReplies.some((item) => item.id === target.textId);
  return ruleIds ? ruleIds.has(target.ruleId) : true;
}

export function validateCustomReply(reply: CustomReply): string | null {
  if (!reply || typeof reply !== "object") return "Custom reply is invalid.";
  if (typeof reply.id !== "string" || !/^[a-z0-9]{1,24}$/.test(reply.id)) return "Custom reply ID is invalid.";
  if (typeof reply.label !== "string" || !reply.label.trim() || reply.label.length > 80) return "Custom reply name must be 1–80 characters.";
  if (typeof reply.text !== "string" || !reply.text.trim() || reply.text.length > MAX_CUSTOM_REPLY_LENGTH) return "Custom reply text must be 1–1,000 characters.";
  return null;
}

export function validateStoryRule(rule: StoryRule): string | null {
  if (!rule || typeof rule !== "object") return "Story rule is invalid.";
  if (typeof rule.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(rule.id)) return "Story rule ID is invalid.";
  if (typeof rule.label !== "string" || !rule.label.trim() || rule.label.length > 80) return "Story rule name must be 1–80 characters.";
  if (typeof rule.storyId !== "string" || (rule.storyId && !/^\d{1,40}$/.test(rule.storyId))) return "Story ID must contain numbers only.";
  if (typeof rule.storyUrl !== "string" || (rule.storyUrl && !validHttpsUrl(rule.storyUrl))) return "Story or link-sticker URL must use HTTPS.";
  if (typeof rule.keyword !== "string" || rule.keyword.length > 80) return "Story keyword must be 80 characters or fewer.";
  if (!rule.storyId && !rule.storyUrl && !rule.keyword.trim()) return "Add a story ID, URL, or keyword.";
  if (!isReplyKey(rule.reply)) return "Choose a reply for the story rule.";
  if (typeof rule.enabled !== "boolean") return "Story rule status is invalid.";
  return null;
}

/**
 * Validates the stored shape. Rule IDs live in another table, so they are
 * checked against `ruleIds` only when the caller provides them (when saving).
 */
export function validateDmFeatureSettings(settings: DmFeatureSettings, ruleIds?: ReadonlySet<number>): string | null {
  if (!settings || typeof settings !== "object") return "DM settings are invalid.";
  if (typeof settings.startersEnabled !== "boolean" || typeof settings.followerCheckEnabled !== "boolean") return "Feature status is invalid.";
  if (!Array.isArray(settings.customReplies) || settings.customReplies.length > MAX_CUSTOM_REPLIES) return `Use no more than ${MAX_CUSTOM_REPLIES} custom replies.`;
  const customIds = new Set<string>();
  for (const reply of settings.customReplies) {
    const error = validateCustomReply(reply);
    if (error) return error;
    if (customIds.has(reply.id)) return "Custom reply IDs must be unique.";
    customIds.add(reply.id);
  }
  if (!Array.isArray(settings.starters) || settings.starters.length > MAX_STARTERS ||
      (settings.startersEnabled && !settings.starters.length)) return "Add between one and four conversation starters.";
  for (const starter of settings.starters) {
    if (!starter || typeof starter.title !== "string" || !starter.title.trim() || starter.title.length > 80) return "Each starter needs a title of 1–80 characters.";
    if (!knownReply(starter.reply, settings.customReplies, ruleIds)) return `Choose an existing reply for the starter “${starter.title}”.`;
  }
  if (typeof settings.followerReply !== "string" || settings.followerReply.length > MAX_GREETING_LENGTH ||
      typeof settings.nonFollowerReply !== "string" || settings.nonFollowerReply.length > MAX_GREETING_LENGTH) return "Follower opening lines must be 80 characters or fewer.";
  if (!Array.isArray(settings.storyRules) || settings.storyRules.length > MAX_STORY_RULES) return `Use no more than ${MAX_STORY_RULES} story rules.`;
  const ids = new Set<string>();
  for (const rule of settings.storyRules) {
    const error = validateStoryRule(rule);
    if (error) return error;
    if (!knownReply(rule.reply, settings.customReplies, ruleIds)) return `Choose an existing reply for the story rule “${rule.label}”.`;
    if (ids.has(rule.id)) return "Story rule IDs must be unique.";
    ids.add(rule.id);
  }
  return null;
}

function textField(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/** Starters and follower checks. Story rules and custom replies have their own editors. */
export function parseDmFeaturesForm(form: FormData, existing: DmFeatureSettings, ruleIds: ReadonlySet<number>): Parsed<DmFeatureSettings> {
  const titles = form.getAll("starter_title");
  const replies = form.getAll("starter_reply");
  const starters: DmStarter[] = [];
  for (let index = 0; index < titles.length; index++) {
    const title = typeof titles[index] === "string" ? (titles[index] as string).trim() : "";
    if (!title) continue;
    const reply = replies[index];
    if (!isReplyKey(reply)) return { ok: false, error: `Choose a reply for the starter “${title}”.` };
    starters.push({ title, reply });
  }
  const settings: DmFeatureSettings = {
    startersEnabled: form.get("starters_enabled") === "on",
    starters,
    followerCheckEnabled: form.get("follower_check_enabled") === "on",
    followerReply: textField(form, "follower_reply"),
    nonFollowerReply: textField(form, "non_follower_reply"),
    // An old or partial settings form cannot erase the separately edited lists.
    customReplies: structuredClone(existing.customReplies),
    storyRules: structuredClone(existing.storyRules)
  };
  const error = validateDmFeatureSettings(settings, ruleIds);
  return error ? { ok: false, error } : { ok: true, settings };
}

export function parseStoryRuleForm(form: FormData): Parsed<StoryRule> {
  const reply = textField(form, "reply");
  const settings: StoryRule = {
    id: textField(form, "id") || crypto.randomUUID(),
    label: textField(form, "label"),
    storyId: textField(form, "story_id"),
    storyUrl: textField(form, "story_url"),
    keyword: textField(form, "keyword"),
    reply,
    enabled: form.get("enabled") === "on"
  };
  const error = validateStoryRule(settings);
  return error ? { ok: false, error } : { ok: true, settings };
}

export function parseCustomReplyForm(form: FormData): Parsed<CustomReply> {
  const settings: CustomReply = {
    id: textField(form, "id") || crypto.randomUUID().replace(/-/g, "").slice(0, 8),
    label: textField(form, "label"),
    text: textField(form, "text")
  };
  const error = validateCustomReply(settings);
  return error ? { ok: false, error } : { ok: true, settings };
}

/** Where a reply key is used. Used to block deleting a reply that is still in use. */
export function replyUsage(settings: DmFeatureSettings, reply: ReplyKey): string[] {
  return [
    ...settings.starters.filter((starter) => starter.reply === reply).map((starter) => `conversation starter “${starter.title}”`),
    ...settings.storyRules.filter((rule) => rule.reply === reply).map((rule) => `story rule “${rule.label}”`)
  ];
}

export async function getDmFeatureSettings(db: D1Database): Promise<DmFeatureSettings> {
  const row = await db.prepare("SELECT value FROM automation_settings WHERE key = 'dm_features'").first<{ value: string }>();
  if (!row) return structuredClone(DEFAULT_DM_FEATURE_SETTINGS);
  try {
    const value: unknown = JSON.parse(row.value);
    if (value && typeof value === "object" && !validateDmFeatureSettings(value as DmFeatureSettings)) {
      // Older settings may still hold keywordRepliesEnabled; migration 0008 moved it to rules.channels.
      const stored = value as DmFeatureSettings;
      return {
        startersEnabled: stored.startersEnabled, starters: stored.starters,
        followerCheckEnabled: stored.followerCheckEnabled, followerReply: stored.followerReply,
        nonFollowerReply: stored.nonFollowerReply,
        customReplies: stored.customReplies, storyRules: stored.storyRules
      };
    }
  } catch { /* Invalid saved settings must not activate a new reply. */ }
  return {
    ...structuredClone(DEFAULT_DM_FEATURE_SETTINGS),
    startersEnabled: false, followerCheckEnabled: false, storyRules: []
  };
}

export async function saveDmFeatureSettings(db: D1Database, settings: DmFeatureSettings): Promise<void> {
  const error = validateDmFeatureSettings(settings);
  if (error) throw new Error(error);
  await db.prepare(
    `INSERT INTO automation_settings (key, value, updated_at) VALUES ('dm_features', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(JSON.stringify({ ...settings, revision: crypto.randomUUID() }), new Date().toISOString()).run();
}

class FeatureError extends Error {}

function apiUrl(env: FeatureEnv, path: string): URL {
  try {
    const base = new URL(env.GRAPH_API_BASE);
    if (base.protocol !== "https:" || base.hostname !== "graph.instagram.com" || base.username || base.password || base.port || base.search || base.hash || !/^\/v\d+\.\d+\/?$/.test(base.pathname)) throw new Error();
    return new URL(`${base.href.replace(/\/$/, "")}/${path}`);
  } catch { throw new FeatureError("Use the official Instagram Graph API address."); }
}

async function readApiJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new FeatureError("Instagram returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_JSON_BYTES) { await reader.cancel(); throw new FeatureError("Instagram returned an unexpected response."); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const result: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result as Record<string, unknown>;
  } catch { throw new FeatureError("Instagram returned an unexpected response."); }
}

async function graphRequest(env: FeatureEnv, url: URL, method = "GET", body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  let token: string;
  try { token = await getInstagramAccessToken(env); }
  catch { throw new FeatureError("Check the Instagram connection, then try again."); }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      // Workers supports manual/follow only. Never forward credentials to a redirect destination.
      redirect: "manual",
      signal: controller.signal
    });
    if (response.status >= 300 && response.status < 400) throw new FeatureError("Instagram returned an unexpected redirect.");
    const data = await readApiJson(response);
    const error = data.error && typeof data.error === "object" ? data.error as Record<string, unknown> : null;
    if (response.status === 401 || error?.code === 190 || error?.code === 102) throw new FeatureError("Instagram rejected the token. Check the connection.");
    if (response.status === 403 || error?.code === 10 || error?.code === 200) throw new FeatureError("Instagram did not allow this request. Check messaging permissions.");
    if (!response.ok || error) throw new FeatureError("Instagram could not complete this request. Try again later.");
    return data;
  } catch (error) {
    if (error instanceof FeatureError) throw error;
    // Native fetch errors can contain request details. Keep messages generic.
    throw new FeatureError("Instagram could not be reached. Try again later.");
  } finally { clearTimeout(timeout); }
}

function profileFromRow(row: ProfileRow): InstagramProfile {
  return { username: row.username, isFollower: row.is_follower === 1 ? true : row.is_follower === 0 ? false : null, checkedAt: new Date(row.checked_at).toISOString(), error: row.safe_error };
}

/** Call only after the sender has messaged or tapped a conversation starter (user consent). */
export async function lookupInstagramProfile(env: FeatureEnv, senderId: string, now = Date.now()): Promise<InstagramProfile> {
  if (!/^\d{1,40}$/.test(senderId)) return { username: null, isFollower: null, checkedAt: null, error: "Instagram sender ID is invalid." };
  const cached = await env.DB.prepare("SELECT username, is_follower, checked_at, expires_at, safe_error FROM instagram_profiles WHERE owner_id = ? AND sender_id = ?")
    .bind(env.IG_USER_ID, senderId).first<ProfileRow>();
  if (cached && cached.checked_at <= now && now - cached.checked_at < DAY && cached.expires_at > now) return profileFromRow(cached);
  let result: InstagramProfile;
  try {
    const url = apiUrl(env, encodeURIComponent(senderId));
    url.searchParams.set("fields", "username,is_user_follow_business");
    const data = await graphRequest(env, url);
    const username = typeof data.username === "string" && INSTAGRAM_USERNAME.test(data.username) ? data.username : null;
    const isFollower = typeof data.is_user_follow_business === "boolean" ? data.is_user_follow_business : null;
    result = { username, isFollower, checkedAt: new Date(now).toISOString(), error: isFollower === null ? "Instagram did not return follow status." : null };
  } catch (error) {
    result = { username: null, isFollower: null, checkedAt: new Date(now).toISOString(), error: error instanceof FeatureError ? error.message : "Profile lookup could not finish." };
  }
  await env.DB.prepare(
    `INSERT INTO instagram_profiles (owner_id, sender_id, username, is_follower, checked_at, expires_at, safe_error)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, sender_id) DO UPDATE SET
     username = excluded.username, is_follower = excluded.is_follower, checked_at = excluded.checked_at,
     expires_at = excluded.expires_at, safe_error = excluded.safe_error`
  ).bind(env.IG_USER_ID, senderId, result.username, result.isFollower === null ? null : result.isFollower ? 1 : 0,
    now, now + (result.error ? PROFILE_FAILURE_TTL : DAY), result.error).run();
  return result;
}

function desiredStarters(settings: DmFeatureSettings): Array<{ question: string; payload: string }> {
  return settings.startersEnabled
    ? settings.starters.map((starter) => ({ question: starter.title, payload: buildReplyPayload(starter.reply) }))
    : [];
}

async function publicationHash(settings: DmFeatureSettings): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(desiredStarters(settings))));
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function publicationRecord(db: D1Database): Promise<PublicationRecord | null> {
  const row = await db.prepare("SELECT value FROM automation_settings WHERE key = ?").bind(PUBLICATION_KEY).first<{ value: string }>();
  if (!row) return null;
  try {
    const value = JSON.parse(row.value) as Partial<PublicationRecord>;
    if (!value || !["not_published", "pending", "synced", "error"].includes(value.state ?? "")) return null;
    return { state: value.state as PublicationRecord["state"], error: typeof value.error === "string" ? value.error : null,
      syncedAt: typeof value.syncedAt === "string" ? value.syncedAt : null,
      settingsHash: typeof value.settingsHash === "string" ? value.settingsHash : null,
      leaseOwner: typeof value.leaseOwner === "string" ? value.leaseOwner : null,
      leaseUntil: typeof value.leaseUntil === "number" ? value.leaseUntil : 0 };
  } catch { return null; }
}

/** Saved starters that differ from the last published set show as "Changes not published". */
export async function getIceBreakersPublicationStatus(db: D1Database, settings?: DmFeatureSettings): Promise<IceBreakersPublicationStatus> {
  const record = await publicationRecord(db);
  if (!record) return { state: "not_published", error: null, syncedAt: null };
  const expectedHash = await publicationHash(settings ?? await getDmFeatureSettings(db));
  const changed = record.settingsHash != null && record.settingsHash !== expectedHash;
  return { state: changed ? "pending" : record.state, error: changed ? null : record.error, syncedAt: record.syncedAt };
}

function parseRemoteStarters(data: Record<string, unknown>): InstagramIceBreakersResult["starters"] {
  if (!Array.isArray(data.data)) throw new FeatureError("Instagram returned an unexpected starter list.");
  const wrappers: Record<string, unknown>[] = [];
  for (const item of data.data) {
    if (!item || typeof item !== "object") continue;
    if (Array.isArray(item.ice_breakers)) wrappers.push(...item.ice_breakers.filter((value: unknown) => value && typeof value === "object"));
    else wrappers.push(item);
  }
  const wrapper = wrappers.find((item) => item.locale === "default") ?? wrappers.find((item) => !item.locale) ?? wrappers[0];
  if (!wrapper) return [];
  if (!Array.isArray(wrapper.call_to_actions)) throw new FeatureError("Instagram returned an unexpected starter list.");
  const starters: InstagramIceBreakersResult["starters"] = [];
  for (const item of wrapper.call_to_actions) {
    if (!item || typeof item !== "object" || typeof item.question !== "string" || typeof item.payload !== "string") throw new FeatureError("Instagram returned an unexpected starter list.");
    starters.push({ title: item.question, payload: item.payload, reply: parseReplyPayload(item.payload) });
  }
  return starters;
}

export async function getInstagramIceBreakers(env: FeatureEnv): Promise<InstagramIceBreakersResult> {
  try {
    const url = apiUrl(env, "me/messenger_profile");
    url.searchParams.set("fields", "ice_breakers");
    const data = await graphRequest(env, url);
    return { starters: parseRemoteStarters(data), error: null };
  } catch (error) {
    return { starters: [], error: error instanceof FeatureError ? error.message : "Conversation starters could not be checked." };
  }
}

/**
 * Publishes the saved starters (or removes them when starters are off), then
 * reads Instagram's configuration back. Only a matching readback marks the
 * starters as published. Saving settings never publishes anything.
 */
export async function publishIceBreakers(env: FeatureEnv, settings?: DmFeatureSettings, now = Date.now()): Promise<IceBreakersPublicationStatus> {
  const desired = settings ?? await getDmFeatureSettings(env.DB);
  const validation = validateDmFeatureSettings(desired);
  if (validation) return { state: "error", error: validation, syncedAt: null };
  const hash = await publicationHash(desired);
  const owner = crypto.randomUUID();
  await env.DB.prepare("INSERT OR IGNORE INTO automation_settings (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(PUBLICATION_KEY, JSON.stringify({ state: "not_published", error: null, syncedAt: null, settingsHash: null, leaseUntil: 0, leaseOwner: null }), new Date(now).toISOString()).run();
  // A short lease keeps overlapping publish clicks from sending two updates.
  const claim = await env.DB.prepare(
    `UPDATE automation_settings SET value = json_set(value, '$.leaseOwner', ?, '$.leaseUntil', ?, '$.state', 'pending', '$.error', NULL), updated_at = ?
     WHERE key = ? AND COALESCE(json_extract(value, '$.leaseUntil'), 0) <= ?`
  ).bind(owner, now + 60000, new Date(now).toISOString(), PUBLICATION_KEY, now).run();
  if (claim.meta.changes !== 1) return getIceBreakersPublicationStatus(env.DB, desired);
  let state: "synced" | "error" = "synced";
  let error: string | null = null;
  try {
    const url = apiUrl(env, `${encodeURIComponent(env.IG_USER_ID)}/messenger_profile`);
    const payload = desired.startersEnabled
      ? { platform: "instagram", ice_breakers: [{ locale: "default", call_to_actions: desiredStarters(desired) }] }
      : { fields: ["ice_breakers"] };
    const result = await graphRequest(env, url, desired.startersEnabled ? "POST" : "DELETE", payload);
    // Meta's mutation response varies between API versions. Only a matching
    // readback below confirms publication; an HTTP 200 alone never does.
    if (result.success === false) throw new FeatureError("Instagram did not confirm the starter update.");
    const verified = await getInstagramIceBreakers(env);
    if (verified.error) throw new FeatureError(verified.error);
    const actual = verified.starters.map((starter) => ({ question: starter.title, payload: starter.payload }));
    if (JSON.stringify(actual) !== JSON.stringify(desiredStarters(desired))) throw new FeatureError("Instagram has not returned the updated starters yet. Try publishing again.");
  } catch (caught) {
    state = "error";
    error = caught instanceof FeatureError ? caught.message : "Conversation starters could not be published.";
  }
  const previous = await publicationRecord(env.DB);
  await env.DB.prepare(
    `UPDATE automation_settings SET value = ?, updated_at = ? WHERE key = ? AND json_extract(value, '$.leaseOwner') = ?`
  ).bind(JSON.stringify({ state, error, syncedAt: state === "synced" ? new Date(now).toISOString() : previous?.syncedAt ?? null,
    settingsHash: hash, leaseOwner: null, leaseUntil: 0 }), new Date(now).toISOString(), PUBLICATION_KEY, owner).run();
  return getIceBreakersPublicationStatus(env.DB);
}
