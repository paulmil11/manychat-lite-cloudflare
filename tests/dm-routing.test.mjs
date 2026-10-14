import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildWorker, createHarness } from "./worker-harness.mjs";

// Signed DM webhooks through the real Worker: starters, story replies, DM links,
// automations that listen on DMs and follower checks. Every Meta request is mocked.
const OWNER = "900000000000001";
const READER = "900000000000002";
const GUIDE = "rule-2";
const WORKSHOP = "rule-3";
const ASK = "text-ask";
// Both automations answer comments and DMs, but not story replies.
const RULES = [
  { label: "Free guide", keywords: '["GUIDE"]', reply_text: "Here is the free guide.", link_url: "https://example.com/guide", link_button_label: "Open guide" },
  { label: "Workshop waitlist", keywords: '["WORKSHOP"]', reply_text: "Join the workshop waitlist.", link_url: "https://example.com/workshop", link_button_label: "Join waitlist" },
];
const COMMENTS_AND_DMS = '["comments","dms"]';

let built;
before(async () => { built = await buildWorker(); });
after(async () => { await built?.dispose(); });

function settings(h) {
  return JSON.parse(h.query("SELECT value FROM automation_settings WHERE key = 'dm_features'").value);
}

async function setSettings(h, values) {
  const next = { ...settings(h), ...values };
  await h.db.prepare("UPDATE automation_settings SET value = ? WHERE key = 'dm_features'").bind(JSON.stringify(next)).run();
  return next;
}

async function fixture(t, overrides = {}, featureOverrides = {}) {
  const h = await createHarness(built.worker, {
    IG_USER_ID: OWNER,
    GRAPH_API_BASE: "https://graph.instagram.com/v25.0",
    ...overrides,
  });
  t.after(() => h.dispose());
  const now = new Date().toISOString();
  for (const rule of RULES) {
    await h.db.prepare(`INSERT INTO rules (label, channels, keywords, reply_text, link_url, link_button_label, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).bind(rule.label, COMMENTS_AND_DMS, rule.keywords, rule.reply_text, rule.link_url, rule.link_button_label, now, now).run();
  }
  assert.deepEqual(h.queryAll("SELECT id FROM rules WHERE active = 1 ORDER BY id").map((row) => `rule-${row.id}`), [GUIDE, WORKSHOP]);
  await setSettings(h, featureOverrides);
  return h;
}

function payload(event) {
  return { object: "instagram", entry: [{ id: OWNER, messaging: [{
    sender: { id: READER }, recipient: { id: OWNER }, timestamp: Date.now(), ...event,
  }] }] };
}

function dm(id, text, extra = {}) {
  return payload({ message: { mid: id, text, ...extra } });
}

function starter(reply, extra = {}) {
  return payload({ postback: { title: "Starter", payload: `DM_REPLY__${reply}`, ...extra } });
}

function referral(ref, overrides = {}) {
  return { ref, source: "SHORTLINKS", type: "OPEN_THREAD", ...overrides };
}

function sends(h) {
  return h.calls.filter((call) => call.method === "POST" && call.url.pathname.endsWith("/messages"));
}

function profiles(h) {
  return h.calls.filter((call) => call.method === "GET" && call.url.searchParams.get("fields")?.includes("is_user_follow_business"));
}

function sentMessage(h, index = 0) {
  return sends(h)[index]?.body.message;
}

function eventRow(h, id) {
  return h.query("SELECT * FROM message_events WHERE message_id = ?", id);
}

function assertReply(message, reply) {
  assert.ok(message, "Expected a sent message");
  if (reply === ASK) {
    assert.match(message.text, /Send your question here/);
    return;
  }
  const url = reply === GUIDE ? "https://example.com/guide" : "https://example.com/workshop";
  assert.equal(message.attachment.payload.template_type, "button");
  assert.deepEqual(message.attachment.payload.buttons.map((button) => button.url), [url]);
}

function profileResponder(isFollower, username = "demo_reader") {
  return (call) => Response.json(call.method === "GET"
    ? { username, ...(isFollower === undefined ? {} : { is_user_follow_business: isFollower }) }
    : { message_id: "sent-test-id" });
}

test("signed starters reply with keyword rules or custom replies and deduplicate postbacks without an ID", async (t) => {
  const h = await fixture(t, {}, { startersEnabled: true, starters: [{ title: "Get the guide", reply: GUIDE }, { title: "Ask a question", reply: ASK }] });
  for (const [index, reply] of [GUIDE, ASK].entries()) {
    const input = starter(reply);
    const responses = await Promise.all([h.webhook(input), h.webhook(input)]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    assert.equal(sends(h).length, index + 1);
    assertReply(sentMessage(h, index), reply);
    assert.deepEqual(sends(h)[index].body.recipient, { id: READER });
  }
  assert.equal(h.query("SELECT COUNT(*) AS count FROM message_events").count, 2);
  assert.deepEqual(h.queryAll("SELECT source, status, reply_key, matched_choice FROM message_events ORDER BY reply_key"), [
    { source: "starter", status: "sent", reply_key: GUIDE, matched_choice: "Free guide" },
    { source: "starter", status: "sent", reply_key: ASK, matched_choice: "Ask a question" },
  ]);
  assert.equal(profiles(h).length, 0);
});

test("story ID and sticker-link rules take priority over keyword-only story rules", async (t) => {
  const h = await fixture(t, {}, { storyRules: [
    { id: "generic", label: "Any GUIDE reply", storyId: "", storyUrl: "", keyword: "GUIDE", reply: GUIDE, enabled: true },
    { id: "specific", label: "Workshop story", storyId: "12345", storyUrl: "", keyword: "", reply: WORKSHOP, enabled: true },
    { id: "sticker", label: "Questions story", storyId: "", storyUrl: "https://example.com/questions", keyword: "", reply: ASK, enabled: true },
  ] });
  await h.webhook(dm("story-id", "GUIDE", { reply_to: { story: { id: "12345", url: "https://cdn.example.test/story" } } }));
  assertReply(sentMessage(h), WORKSHOP);
  const row = eventRow(h, "story-id");
  assert.equal(row.source, "story_reply");
  assert.equal(row.story_id, "12345");
  assert.equal(row.story_url, "https://cdn.example.test/story");
  await h.webhook(dm("story-sticker", "GUIDE", { reply_to: { story: { id: "98765", link_sticker_url: "https://example.com/questions" } } }));
  assertReply(sentMessage(h, 1), ASK);
  assert.equal(eventRow(h, "story-sticker").story_link_url, "https://example.com/questions");
  await h.webhook(dm("story-generic", "send the guide please", { reply_to: { story: { id: "55555" } } }));
  assertReply(sentMessage(h, 2), GUIDE);
  await h.webhook(dm("story-unmatched", "nice story", { reply_to: { story: { id: "55555" } } }));
  assert.equal(eventRow(h, "story-unmatched").status, "ignored_no_match");
  assert.equal(sends(h).length, 3);
});

test("a paused matching story rule blocks DM keywords and broader story rules", async (t) => {
  const h = await fixture(t, {}, { storyRules: [
    { id: "generic", label: "Any GUIDE reply", storyId: "", storyUrl: "", keyword: "GUIDE", reply: GUIDE, enabled: true },
    { id: "paused", label: "Paused story", storyId: "12345", storyUrl: "", keyword: "", reply: WORKSHOP, enabled: false },
  ] });
  await h.webhook(dm("paused-story", "GUIDE", { reply_to: { story: { id: "12345" } } }));
  assert.equal(sends(h).length, 0);
  assert.equal(eventRow(h, "paused-story").status, "ignored_paused");
  assert.equal(eventRow(h, "paused-story").matched_choice, "Paused story");
});

test("story mentions without text can match a configured URL without fetching story media", async (t) => {
  const url = "https://cdn.example.test/mentioned-story";
  const h = await fixture(t, {}, { storyRules: [
    { id: "mention", label: "Mentioned story", storyId: "", storyUrl: url, keyword: "", reply: ASK, enabled: true },
  ] });
  await h.webhook(payload({ message: { mid: "story-mention", attachments: [{ type: "story_mention", payload: { url } }] } }));
  assertReply(sentMessage(h), ASK);
  assert.equal(eventRow(h, "story-mention").source, "story_mention");
  assert.equal(eventRow(h, "story-mention").story_url, url);
  assert.equal(h.calls.some((call) => call.url.hostname === "cdn.example.test"), false);
});

test("DM links work in each webhook shape, and starters and DM keywords win over a link", async (t) => {
  const h = await fixture(t, {}, {
    followerCheckEnabled: true, startersEnabled: true,
    starters: [{ title: "Ask a question", reply: ASK }],
  });
  h.setResponder(profileResponder(true));
  const standalone = payload({ referral: referral(`${GUIDE}__website`) });
  await h.webhook(standalone);
  await h.webhook(standalone);
  assert.equal(sends(h).length, 1);
  assertReply(sentMessage(h), GUIDE);
  assert.equal(profiles(h).length, 0, "Opening a link alone must not start a profile lookup");
  const linkRow = h.query("SELECT source, referral_ref, reply_key FROM message_events WHERE source = 'referral'");
  assert.deepEqual(linkRow, { source: "referral", referral_ref: `${GUIDE}__website`, reply_key: GUIDE });
  await h.webhook(dm("ref-message", "hello", { referral: referral(`${WORKSHOP}__email`) }));
  assertReply(sentMessage(h, 1), WORKSHOP);
  assert.equal(eventRow(h, "ref-message").referral_ref, `${WORKSHOP}__email`);
  await h.webhook(starter(ASK, { mid: "ref-postback", referral: referral(`${GUIDE}__website`) }));
  assertReply(sentMessage(h, 2), ASK);
  await h.webhook(dm("ref-typed", "GUIDE", { referral: referral(`${WORKSHOP}__email`) }));
  assertReply(sentMessage(h, 3), GUIDE);
  assert.equal(profiles(h).length, 1, "Later messages from the same person reuse the cached profile");
});

test("unknown referral sources, event types and reply keys cannot send", async (t) => {
  const h = await fixture(t, {}, { followerCheckEnabled: true });
  for (const value of [
    referral(`${GUIDE}__website`, { source: "ADS" }),
    referral(`${GUIDE}__website`, { type: "CLICK" }),
    referral("unknown__website"),
    referral(`${GUIDE}__bad source`),
  ]) await h.webhook(payload({ referral: value }));
  assert.equal(h.calls.length, 0);
  await h.webhook(payload({ mid: "missing-rule", referral: referral("rule-999__website") }));
  assert.equal(eventRow(h, "missing-rule").status, "ignored_missing_reply");
  await h.webhook(payload({ mid: "missing-text", referral: referral("text-gone__website") }));
  assert.equal(eventRow(h, "missing-text").status, "ignored_missing_reply");
  assert.equal(h.calls.length, 0);
});

test("stale, missing and future timestamps, echoes, deletions and wrong recipients never call Meta", async (t) => {
  const h = await fixture(t, {}, { followerCheckEnabled: true });
  const now = Date.now();
  const variants = [
    { timestamp: now - 25 * 60 * 60 * 1000 },
    { timestamp: undefined },
    { timestamp: now + 10 * 60 * 1000 },
    { message: { mid: "echo", text: "GUIDE", is_echo: true } },
    { recipient: { id: "900000000000999" } },
    { sender: { id: OWNER } },
    { message: { mid: "deleted", text: "GUIDE", is_deleted: true } },
  ];
  for (const [index, variant] of variants.entries()) {
    await h.webhook(payload({ message: { mid: `blocked-${index}`, text: "GUIDE" }, ...variant }));
  }
  assert.equal(h.calls.length, 0);
  assert.equal(eventRow(h, "blocked-0").status, "ignored_expired");
  assert.equal(eventRow(h, "blocked-1").status, "ignored_invalid");
  assert.equal(eventRow(h, "blocked-2").status, "ignored_invalid");
  assert.equal(eventRow(h, "blocked-4").status, "ignored_recipient");
  assert.equal(eventRow(h, "blocked-5").status, "ignored_self");
  assert.equal(eventRow(h, "echo"), null, "Echoes are not recorded");
});

test("DMs match automations that listen on DMs, with the same strict rule as comments", async (t) => {
  const h = await fixture(t);
  await h.webhook(dm("keyword-dm", "could you send the guide?"));
  assertReply(sentMessage(h), GUIDE);
  assert.equal(eventRow(h, "keyword-dm").reply_key, GUIDE);
  await h.webhook(dm("keyword-story", "GUIDE", { reply_to: { story: { id: "4242" } } }));
  assert.equal(eventRow(h, "keyword-story").status, "ignored_no_match", "Story replies need the story replies channel");
  await h.webhook(dm("keyword-partial", "read the guidelines"));
  assert.equal(eventRow(h, "keyword-partial").status, "ignored_no_match");
  await h.webhook(dm("keyword-chatter", "I loved your guide last week, thank you"));
  assert.equal(eventRow(h, "keyword-chatter").status, "ignored_no_match");
  await h.db.prepare("UPDATE rules SET active = 0 WHERE label = 'Workshop waitlist'").run();
  await h.webhook(dm("keyword-inactive", "WORKSHOP"));
  assert.equal(eventRow(h, "keyword-inactive").status, "ignored_no_match");
  await h.db.prepare(`UPDATE rules SET channels = '["comments"]' WHERE label = 'Free guide'`).run();
  await h.webhook(dm("keyword-comments-only", "GUIDE"));
  assert.equal(eventRow(h, "keyword-comments-only").status, "ignored_no_match", "A comments-only automation ignores DMs");
  assert.equal(sends(h).length, 1);
});

test("follower checks store true, false and unknown status and add only the matching opening line", async (t) => {
  const h = await fixture(t, {}, { followerCheckEnabled: true, followerReply: "Thanks for following.", nonFollowerReply: "Welcome here." });
  const cases = [
    { state: true, stored: 1, greeting: "Thanks for following.", absent: "Welcome here." },
    { state: false, stored: 0, greeting: "Welcome here.", absent: "Thanks for following." },
    { state: undefined, stored: null, greeting: null, absent: "Thanks for following." },
  ];
  for (const [index, item] of cases.entries()) {
    h.setResponder(profileResponder(item.state, `demo_reader_${index}`));
    const input = dm(`profile-${index}`, "GUIDE");
    input.entry[0].messaging[0].sender.id = `${READER}${index}`;
    await h.webhook(input);
    const message = sentMessage(h, index);
    const serialized = JSON.stringify(message);
    assertReply(message, GUIDE);
    if (item.greeting) assert.equal(message.attachment.payload.text, `${item.greeting}\n\nHere is the free guide.`);
    assert.ok(!serialized.includes(item.absent));
    if (item.state === undefined) assert.ok(!serialized.includes("Welcome here."));
    const row = eventRow(h, `profile-${index}`);
    assert.equal(row.sender_username, `demo_reader_${index}`);
    assert.equal(row.is_follower, item.stored);
    assert.ok(row.profile_checked_at);
    assert.equal(row.source, "dm");
    if (item.state === undefined) assert.ok(row.profile_error);
  }
  assert.equal(profiles(h).length, 3);
  for (const call of profiles(h)) {
    assert.equal(call.headers.get("authorization"), "Bearer test-instagram-access-token");
    assert.equal(call.url.searchParams.get("access_token"), null);
  }
});

test("a failed profile lookup still sends the reply and never counts as a non-follower", async (t) => {
  const h = await fixture(t, {}, { followerCheckEnabled: true, followerReply: "Follower line", nonFollowerReply: "Non-follower line" });
  h.setResponder((call) => call.method === "GET"
    ? new Response(JSON.stringify({ error: { message: "User consent required", code: 10 } }), { status: 403 })
    : Response.json({ message_id: "sent" }));
  await h.webhook(dm("profile-failure", "GUIDE"));
  assertReply(sentMessage(h), GUIDE);
  assert.doesNotMatch(JSON.stringify(sentMessage(h)), /Follower line|Non-follower line/);
  const row = eventRow(h, "profile-failure");
  assert.equal(row.status, "sent");
  assert.equal(row.is_follower, null);
  assert.ok(row.profile_error);
});

test("an opening line is skipped when the reply would exceed Instagram's limit", async (t) => {
  const greeting = "g".repeat(80);
  const h = await fixture(t, {}, {
    followerCheckEnabled: true, followerReply: greeting,
    customReplies: [{ id: "ask", label: "Ask a question", text: "a".repeat(990) }],
    storyRules: [{ id: "s", label: "Questions", storyId: "1", storyUrl: "", keyword: "", reply: ASK, enabled: true }],
  });
  h.setResponder(profileResponder(true));
  await h.db.prepare("UPDATE rules SET reply_text = ? WHERE label = 'Free guide'").bind("b".repeat(640)).run();
  await h.webhook(dm("long-button", "GUIDE"));
  assert.equal(sentMessage(h).attachment.payload.text, "b".repeat(640));
  await h.webhook(dm("long-text", "hi", { reply_to: { story: { id: "1" } } }));
  assert.equal(sentMessage(h, 1).text, "a".repeat(990));
  assert.equal(sends(h).length, 2, "An opening line never becomes a separate DM");
});

const SETTINGS_FORM = {
  starters_enabled: "on", starter_title: "Get the guide", starter_reply: GUIDE, follower_check_enabled: "on",
  follower_reply: "", non_follower_reply: "",
};

test("DM tool routes require login, reject cross-origin writes and validate limits", async (t) => {
  const h = await fixture(t);
  const before = settings(h);
  const paths = ["/admin/dm-features", "/admin/story-rules", "/admin/custom-replies", "/admin/dm-features/publish"];
  for (const path of paths) {
    const response = await h.postForm(path, SETTINGS_FORM);
    assert.equal(response.status, 303, path);
    assert.equal(response.headers.get("location"), "/admin", path);
  }
  assert.equal((await h.request("/admin/dm-features")).status, 401);
  const cookie = await h.login();
  for (const path of paths) {
    const response = await h.request(path, { method: "POST", headers: { cookie, origin: "https://untrusted.example.test" }, body: new URLSearchParams(SETTINGS_FORM) });
    assert.equal(response.status, 403, path);
  }
  assert.deepEqual(settings(h), before);
  const tooLong = await h.postForm("/admin/dm-features", { ...SETTINGS_FORM, follower_reply: "x".repeat(81) }, cookie);
  assert.equal(tooLong.status, 400);
  const missingRule = await h.postForm("/admin/dm-features", { ...SETTINGS_FORM, starter_reply: "rule-999" }, cookie);
  assert.equal(missingRule.status, 400);
  assert.deepEqual(settings(h), before);
  const accepted = await h.postForm("/admin/dm-features", { ...SETTINGS_FORM, follower_reply: "x".repeat(80) }, cookie);
  assert.equal(accepted.status, 303, await accepted.text());
  assert.equal(settings(h).followerReply.length, 80);
  assert.deepEqual(settings(h).starters, [{ title: "Get the guide", reply: GUIDE }]);
  assert.deepEqual(settings(h).customReplies, before.customReplies, "The settings form keeps custom replies");
  const json = await (await h.request("/admin/dm-features", { headers: { cookie } })).json();
  assert.equal(json.settings.startersEnabled, true);
  assert.equal(json.publication.state, "not_published");
  assert.equal(h.calls.length, 0, "Saving settings must not publish starters or send messages");
});

const STORY_FORM = { label: "Workshop launch", story_id: "12345", story_url: "", keyword: "", reply: WORKSHOP, enabled: "on", action: "save" };

test("story rules can be created, updated, paused and deleted without erasing other settings", async (t) => {
  const h = await fixture(t, {}, { followerReply: "Keep me" });
  const cookie = await h.login();
  const created = await h.postForm("/admin/story-rules", { ...STORY_FORM, id: "" }, cookie);
  assert.equal(created.status, 303, await created.text());
  let rule = settings(h).storyRules.find((item) => item.label === "Workshop launch");
  const ruleId = rule.id;
  assert.equal(rule.storyId, "12345");
  assert.equal(rule.reply, WORKSHOP);
  const updated = await h.postForm("/admin/story-rules", { ...STORY_FORM, id: ruleId, label: "Paused launch", enabled: "" }, cookie);
  assert.equal(updated.status, 303, await updated.text());
  rule = settings(h).storyRules.find((item) => item.id === ruleId);
  assert.equal(rule.enabled, false);
  assert.equal(rule.label, "Paused launch");
  for (const invalid of [{ story_id: "", story_url: "", keyword: "" }, { reply: "rule-999" }, { reply: "text-missing" }]) {
    const response = await h.postForm("/admin/story-rules", { ...STORY_FORM, id: ruleId, ...invalid }, cookie);
    assert.equal(response.status, 400, JSON.stringify(invalid));
  }
  assert.equal(settings(h).storyRules.find((item) => item.id === ruleId).enabled, false);
  assert.equal((await h.postForm("/admin/story-rules", { ...STORY_FORM, id: "missing" }, cookie)).status, 404);
  const removed = await h.postForm("/admin/story-rules", { action: "delete", id: ruleId }, cookie);
  assert.equal(removed.status, 303, await removed.text());
  assert.equal(settings(h).storyRules.length, 0);
  assert.equal(settings(h).followerReply, "Keep me");
  assert.equal(h.calls.length, 0);
});

test("custom replies and rules cannot be deleted while a starter or story rule uses them", async (t) => {
  const h = await fixture(t);
  const cookie = await h.login();
  const created = await h.postForm("/admin/custom-replies", { action: "save", label: "Booking info", text: "Book a call at https://example.com/book" }, cookie);
  assert.equal(created.status, 303, await created.text());
  const reply = settings(h).customReplies.find((item) => item.label === "Booking info");
  assert.match(reply.id, /^[a-z0-9]{8}$/);
  const edited = await h.postForm("/admin/custom-replies", { action: "save", id: reply.id, label: "Booking", text: "Book a call." }, cookie);
  assert.equal(edited.status, 303);
  assert.deepEqual(settings(h).customReplies.find((item) => item.id === reply.id), { id: reply.id, label: "Booking", text: "Book a call." });
  await h.postForm("/admin/dm-features", { ...SETTINGS_FORM, starter_reply: `text-${reply.id}` }, cookie);
  await h.postForm("/admin/story-rules", { ...STORY_FORM, reply: GUIDE }, cookie);
  const blockedText = await h.postForm("/admin/custom-replies", { action: "delete", id: reply.id }, cookie);
  assert.equal(blockedText.status, 400);
  assert.match(await blockedText.text(), /conversation starter/);
  const blockedRule = await h.postForm("/admin/rules/2", { action: "delete" }, cookie);
  assert.equal(blockedRule.status, 400);
  assert.match(await blockedRule.text(), /story rule/);
  assert.ok(h.query("SELECT id FROM rules WHERE id = 2"));
  const unused = await h.postForm("/admin/custom-replies", { action: "delete", id: "ask" }, cookie);
  assert.equal(unused.status, 303);
  assert.equal(settings(h).customReplies.some((item) => item.id === "ask"), false);
  const tooLong = await h.postForm("/admin/custom-replies", { action: "save", label: "Long", text: "x".repeat(1001) }, cookie);
  assert.equal(tooLong.status, 400);
  assert.equal(h.calls.length, 0);
});

test("test mode neither publishes starters nor looks up profiles nor sends DM replies", async (t) => {
  const h = await fixture(t, { DRY_RUN: "true" }, {
    followerCheckEnabled: true, startersEnabled: true,
    starters: [{ title: "Get the guide", reply: GUIDE }],
    storyRules: [{ id: "s", label: "Story", storyId: "12345", storyUrl: "", keyword: "", reply: WORKSHOP, enabled: true }],
  });
  const cookie = await h.login();
  const response = await h.postForm("/admin/dm-features/publish", {}, cookie);
  assert.equal(response.status, 409);
  await h.webhook(starter(GUIDE, { mid: "dry-starter" }));
  await h.webhook(dm("dry-story", "hello", { reply_to: { story: { id: "12345" } } }));
  await h.webhook(dm("dry-keyword", "GUIDE"));
  await h.webhook(payload({ mid: "dry-link", referral: referral(`${WORKSHOP}__website`) }));
  assert.equal(h.calls.length, 0);
  for (const id of ["dry-starter", "dry-story", "dry-keyword"]) assert.equal(eventRow(h, id).status, "dry_run_matched", id);
  assert.equal(eventRow(h, "dry-starter").sent_at, null);
  const state = JSON.parse(h.query("SELECT value FROM automation_settings WHERE key = 'icebreakers_publish'").value);
  assert.notEqual(state.state, "synced");
});

test("publishing from the dashboard sends the saved starters and confirms them", async (t) => {
  const h = await fixture(t, {}, { startersEnabled: true, starters: [{ title: "Get the guide", reply: GUIDE }, { title: "Ask a question", reply: ASK }] });
  const cookie = await h.login();
  let remote = [];
  h.setResponder((call) => {
    if (call.method === "POST") {
      remote = call.body.ice_breakers[0].call_to_actions;
      return Response.json({ success: true });
    }
    return Response.json({ data: [{ locale: "default", call_to_actions: remote }] });
  });
  const response = await h.postForm("/admin/dm-features/publish", {}, cookie);
  assert.equal(response.status, 303);
  assert.deepEqual(remote, [
    { question: "Get the guide", payload: `DM_REPLY__${GUIDE}` },
    { question: "Ask a question", payload: `DM_REPLY__${ASK}` },
  ]);
  const html = await (await h.request("/admin", { headers: { cookie } })).text();
  assert.match(html, />Live on Instagram</);
  assert.match(html, /Last published <time/);
});

test("story URL rules match equivalent normalized URLs", async (t) => {
  const h = await fixture(t, {}, { storyRules: [
    { id: "normalized", label: "Story URL", storyId: "", storyUrl: "https://example.test", keyword: "", reply: WORKSHOP, enabled: true },
  ] });
  await h.webhook(dm("normalized-story", "hi", { reply_to: { story: { id: "12345", url: "https://example.test/" } } }));
  assertReply(sentMessage(h), WORKSHOP);
  await h.webhook(dm("normalized-sticker", "hi", { reply_to: { story: { id: "12346", link_sticker_url: "https://example.test/" } } }));
  assertReply(sentMessage(h, 1), WORKSHOP);
});

test("paused rules and paused starters block replies that point at them", async (t) => {
  const h = await fixture(t, {}, { startersEnabled: true, starters: [{ title: "Get the guide", reply: GUIDE }] });
  await h.db.prepare("UPDATE rules SET active = 0").run();
  await h.webhook(starter(GUIDE, { mid: "paused-rule-starter" }));
  await h.webhook(payload({ mid: "paused-rule-link", referral: referral(`${WORKSHOP}__website`) }));
  assert.equal(eventRow(h, "paused-rule-starter").status, "ignored_paused");
  assert.equal(eventRow(h, "paused-rule-link").status, "ignored_paused");
  await h.db.prepare("UPDATE rules SET active = 1").run();
  await setSettings(h, { startersEnabled: false });
  await h.webhook(starter(GUIDE, { mid: "starters-off" }));
  assert.equal(eventRow(h, "starters-off").status, "ignored_paused");
  assert.equal(sends(h).length, 0);
});

test("unknown postback payloads cannot route by their button title", async (t) => {
  const h = await fixture(t);
  await h.webhook(payload({ postback: { mid: "unknown-postback", title: "GUIDE", payload: "UNKNOWN_PAYLOAD" } }));
  assert.equal(sends(h).length, 0);
  assert.equal(eventRow(h, "unknown-postback").status, "ignored_no_match");
  assert.equal(eventRow(h, "unknown-postback").source, "postback");
});

test("changes-style postback and referral webhooks route and deduplicate", async (t) => {
  const h = await fixture(t, {}, { startersEnabled: true, starters: [{ title: "Get the guide", reply: GUIDE }] });
  const postback = starter(GUIDE, { mid: "changes-postback" }).entry[0].messaging[0];
  const refEvent = payload({ mid: "changes-referral", referral: referral(`${ASK}__newsletter`) }).entry[0].messaging[0];
  const input = { object: "instagram", entry: [{ id: OWNER, changes: [
    { field: "messaging_postbacks", value: postback },
    { field: "messaging_referral", value: refEvent },
  ] }] };
  await h.webhook(input);
  await h.webhook(input);
  assert.equal(sends(h).length, 2);
  // Separate events in one webhook run concurrently; delivery order can vary.
  assertReply(sends(h).find((call) => call.body.message.attachment).body.message, GUIDE);
  assertReply(sends(h).find((call) => call.body.message.text).body.message, ASK);
  assert.equal(eventRow(h, "changes-postback").source, "starter");
  assert.equal(eventRow(h, "changes-referral").source, "referral");
  assert.equal(eventRow(h, "changes-referral").referral_ref, `${ASK}__newsletter`);
});

test("profile cache database failures do not prevent a configured reply", async (t) => {
  const h = await fixture(t, {}, { followerCheckEnabled: true, nonFollowerReply: "Do not add this for unknown status." });
  const originalDatabase = h.env.DB;
  h.env.DB = {
    ...originalDatabase,
    prepare(sql) {
      if (sql.includes("instagram_profiles")) throw new Error("Simulated profile cache failure");
      return originalDatabase.prepare(sql);
    },
  };
  await h.webhook(dm("profile-db-failure", "GUIDE"));
  assertReply(sentMessage(h), GUIDE);
  assert.doesNotMatch(JSON.stringify(sentMessage(h)), /Do not add this/);
  assert.equal(eventRow(h, "profile-db-failure").status, "sent");
  assert.equal(eventRow(h, "profile-db-failure").is_follower, null);
  assert.ok(eventRow(h, "profile-db-failure").profile_error);
});

test("the dashboard shows DM tools, DM links and escaped DM activity", async (t) => {
  const h = await fixture(t, { DRY_RUN: "true" });
  const cookie = await h.login();
  const hostile = '<svg onload=alert(1)> GUIDE';
  await h.webhook(dm("unsafe-dm", hostile, { reply_to: { story: { id: "777", url: "https://cdn.example.test/s?a=1&b=<x>" } } }));
  await h.postForm("/admin/custom-replies", { action: "save", label: '"><script>alert(2)</script>', text: "</textarea><b>bold</b>" }, cookie);
  const response = await h.request("/admin", { headers: { cookie } });
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const raw of [hostile, '"><script>alert(2)</script>', "</textarea><b>bold</b>", "b=<x>"]) {
    assert.equal(html.includes(raw), false, `Raw markup leaked: ${raw}`);
  }
  assert.ok(html.includes("&lt;svg onload=alert(1)&gt; GUIDE"));
  assert.match(html, /id="dm-tools"/);
  assert.match(html, /id="message-activity"/);
  assert.match(html, /Story reply/);
  assert.match(html, /Story ID: 777/);
  assert.ok(html.includes(`https://ig.me/test_owner?ref=${GUIDE}__website`), "DM links use OWNER_IG_USERNAME when the connection has not been checked");
  assert.equal(h.calls.length, 0);
});
