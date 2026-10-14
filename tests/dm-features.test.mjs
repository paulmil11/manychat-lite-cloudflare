import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildModule, createHarness } from "./worker-harness.mjs";

// Unit tests for src/dm-features.ts against the real migrations and a mocked Meta API.
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const STARTERS = [
  { title: "Get the free guide", reply: "rule-1" },
  { title: "Ask a question", reply: "text-ask" },
];
let features;
let built;
before(async () => {
  built = await buildModule("src/dm-features.ts");
  features = built.module;
});
after(async () => { await built?.dispose(); });

async function fixture(t) {
  const h = await createHarness({}, { IG_USER_ID: "900000000000100", GRAPH_API_BASE: "https://graph.instagram.com/v25.0" });
  t.after(() => h.dispose());
  return h;
}

async function enableStarters(h, starters = STARTERS) {
  const settings = await features.getDmFeatureSettings(h.db);
  settings.startersEnabled = true;
  settings.starters = structuredClone(starters);
  await features.saveDmFeatureSettings(h.db, settings);
  return settings;
}

function featureForm(settings) {
  const form = new FormData();
  if (settings.startersEnabled) form.set("starters_enabled", "on");
  if (settings.followerCheckEnabled) form.set("follower_check_enabled", "on");
  form.set("follower_reply", settings.followerReply);
  form.set("non_follower_reply", settings.nonFollowerReply);
  for (const starter of settings.starters) {
    form.append("starter_title", starter.title);
    form.append("starter_reply", starter.reply);
  }
  return form;
}

function remoteStarters(h) {
  let current = [];
  h.setResponder((call) => {
    assert.equal(call.url.hostname, "graph.instagram.com");
    assert.equal(call.headers.get("authorization"), "Bearer test-instagram-access-token");
    assert.equal(call.url.searchParams.has("access_token"), false, "Credentials belong in authorization headers");
    if (call.method === "POST") {
      assert.equal(call.body.platform, "instagram");
      assert.equal(call.body.ice_breakers[0].locale, "default");
      current = call.body.ice_breakers[0].call_to_actions;
      return Response.json({ success: true });
    }
    if (call.method === "DELETE") {
      assert.deepEqual(call.body, { fields: ["ice_breakers"] });
      current = [];
      return Response.json({ success: true });
    }
    assert.equal(call.url.searchParams.get("fields"), "ice_breakers");
    return Response.json({ data: current.length ? [{ locale: "default", call_to_actions: current }] : [] });
  });
}

test("the migration seeds generic defaults that keep every DM tool off", async (t) => {
  const h = await fixture(t);
  const settings = await features.getDmFeatureSettings(h.db);
  assert.deepEqual(settings, features.DEFAULT_DM_FEATURE_SETTINGS);
  assert.equal(settings.startersEnabled, false);
  assert.deepEqual(settings.starters, []);
  assert.equal(settings.followerCheckEnabled, false);
  assert.deepEqual(settings.storyRules, []);
  assert.equal(settings.customReplies.length, 1);
  assert.equal(h.query("SELECT COUNT(*) AS count FROM rules").count, 1, "Only the starter's switched-off example rule exists");
  assert.deepEqual(await features.getIceBreakersPublicationStatus(h.db), { state: "not_published", error: null, syncedAt: null });
  assert.equal(h.calls.length, 0, "Reading defaults must not publish anything");
});

test("the settings form checks starter replies and keeps story rules and custom replies", async (t) => {
  const h = await fixture(t);
  const existing = await features.getDmFeatureSettings(h.db);
  existing.storyRules = [{ id: "story-1", label: "Any guide reply", storyId: "", storyUrl: "", keyword: "GUIDE", reply: "rule-1", enabled: true }];
  const ruleIds = new Set([1]);
  const form = featureForm({ ...existing, startersEnabled: true, starters: STARTERS });
  // The DM keyword switch moved to each automation's channels; an old form field is ignored.
  form.set("keyword_replies_enabled", "on");
  form.set("story_rules", "[]");
  form.set("custom_replies", "[]");
  form.append("starter_title", "");
  form.append("starter_reply", "text-ask");
  const parsed = features.parseDmFeaturesForm(form, existing, ruleIds);
  assert.equal(parsed.ok, true, parsed.error);
  assert.deepEqual(parsed.settings.starters, STARTERS);
  assert.equal("keywordRepliesEnabled" in parsed.settings, false);
  assert.deepEqual(parsed.settings.storyRules, existing.storyRules);
  assert.deepEqual(parsed.settings.customReplies, existing.customReplies);
  await features.saveDmFeatureSettings(h.db, parsed.settings);
  const stored = JSON.parse(h.query("SELECT value FROM automation_settings WHERE key = 'dm_features'").value);
  assert.equal(typeof stored.revision, "string");
  assert.notEqual(stored.revision, "initial");
  assert.deepEqual((await features.getDmFeatureSettings(h.db)).starters, STARTERS);

  const invalid = [
    { starters: [{ title: "Missing rule", reply: "rule-99" }] },
    { starters: [{ title: "Missing text", reply: "text-nope" }] },
    { starters: [{ title: "Bad key", reply: "guide" }] },
    { starters: [...STARTERS, ...STARTERS, { title: "Fifth", reply: "rule-1" }] },
    { starters: [{ title: "x".repeat(81), reply: "rule-1" }] },
    { starters: [] },
    { followerReply: "x".repeat(81) },
  ];
  for (const change of invalid) {
    const result = features.parseDmFeaturesForm(featureForm({ ...existing, startersEnabled: true, starters: STARTERS, ...change }), existing, ruleIds);
    assert.equal(result.ok, false, JSON.stringify(change).slice(0, 80));
  }
  assert.equal(h.calls.length, 0);
});

test("story rules require a target and accept HTTPS link stickers without fetching them", async (t) => {
  const h = await fixture(t);
  const form = new FormData();
  for (const [key, value] of Object.entries({ label: "Workshop story", story_url: "https://example.com/workshop?from=story", reply: "rule-1", enabled: "on" })) form.set(key, value);
  const parsed = features.parseStoryRuleForm(form);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.settings.id);
  assert.equal(parsed.settings.enabled, true);
  form.set("story_url", "");
  assert.equal(features.parseStoryRuleForm(form).ok, false);
  for (const url of ["javascript:alert(1)", "http://example.com/story", "https://user:secret@example.com/story"]) {
    form.set("story_url", url);
    assert.equal(features.parseStoryRuleForm(form).ok, false);
  }
  form.set("story_url", "");
  form.set("keyword", "GUIDE");
  assert.equal(features.parseStoryRuleForm(form).ok, true);
  form.set("story_id", "abc");
  assert.equal(features.parseStoryRuleForm(form).ok, false);
  form.set("story_id", "12345");
  form.set("reply", "not-a-reply");
  assert.equal(features.parseStoryRuleForm(form).ok, false);
  assert.equal(h.calls.length, 0);
});

test("custom replies need a name and a message of at most 1,000 characters", () => {
  const form = new FormData();
  form.set("label", "Ask a question");
  form.set("text", "Send your question here.");
  const parsed = features.parseCustomReplyForm(form);
  assert.equal(parsed.ok, true);
  assert.match(parsed.settings.id, /^[a-z0-9]{8}$/);
  form.set("id", "ask");
  assert.equal(features.parseCustomReplyForm(form).settings.id, "ask");
  for (const [key, value] of [["label", ""], ["label", "x".repeat(81)], ["text", ""], ["text", "x".repeat(1001)], ["id", "Bad ID!"]]) {
    const invalid = new FormData();
    invalid.set("label", "Name");
    invalid.set("text", "Message");
    invalid.set(key, value);
    assert.equal(features.parseCustomReplyForm(invalid).ok, false, `${key}=${value.slice(0, 10)}`);
  }
});

test("reply keys, starter payloads and DM links accept only supported formats", () => {
  assert.equal(features.buildReplyLink("@demo.creator", "rule-3", "website"), "https://ig.me/demo.creator?ref=rule-3__website");
  assert.equal(features.buildReplyLink("demo.creator", "text-ask", "newsletter"), "https://ig.me/demo.creator?ref=text-ask__newsletter");
  assert.equal(features.buildReplyLink("bad/name", "rule-3"), "");
  assert.equal(features.buildReplyLink("demo.creator", "rule-3", "bad source"), "");
  assert.equal(features.buildReplyLink("demo.creator", "unknown"), "");
  assert.deepEqual(features.parseReplyRef("text-ask__newsletter"), { reply: "text-ask", source: "newsletter" });
  assert.deepEqual(features.parseReplyRef("rule-3"), { reply: "rule-3", source: null });
  assert.deepEqual(features.parseReplyRef("rule-3__spring_launch-2"), { reply: "rule-3", source: "spring_launch-2" });
  for (const ref of ["rule-3__https://bad.example", "rule-0__website", "unknown__website", "rule-3__bad source", "TEXT-ask", ""]) {
    assert.equal(features.parseReplyRef(ref), null, ref);
  }
  assert.equal(features.buildReplyPayload("text-ask"), "DM_REPLY__text-ask");
  assert.equal(features.parseReplyPayload("DM_REPLY__rule-12"), "rule-12");
  assert.equal(features.parseReplyPayload("DM_REPLY__rule-x"), null);
  assert.equal(features.parseReplyPayload("GET_STARTED"), null);
  assert.deepEqual(features.parseReplyKey("rule-12"), { type: "rule", ruleId: 12 });
  assert.deepEqual(features.parseReplyKey("text-ask"), { type: "text", textId: "ask" });
  assert.equal(features.parseReplyKey("rule-"), null);
});

test("reply usage lists the starters and story rules that point at a reply", () => {
  const settings = structuredClone(features.DEFAULT_DM_FEATURE_SETTINGS);
  settings.starters = STARTERS;
  settings.storyRules = [{ id: "s1", label: "Workshop story", storyId: "123", storyUrl: "", keyword: "", reply: "rule-1", enabled: true }];
  assert.deepEqual(features.replyUsage(settings, "rule-1"), ["conversation starter “Get the free guide”", "story rule “Workshop story”"]);
  assert.deepEqual(features.replyUsage(settings, "text-ask"), ["conversation starter “Ask a question”"]);
  assert.deepEqual(features.replyUsage(settings, "rule-2"), []);
});

test("follower lookup records a timestamp and caches at most 24 hours per account", async (t) => {
  const h = await fixture(t);
  h.setResponder(() => Response.json({ username: "demo_reader", is_user_follow_business: true }));
  const first = await features.lookupInstagramProfile(h.env, "100001", NOW);
  assert.deepEqual(first, { username: "demo_reader", isFollower: true, checkedAt: new Date(NOW).toISOString(), error: null });
  assert.equal(h.calls[0].url.pathname, "/v25.0/100001");
  assert.equal(h.calls[0].url.searchParams.get("fields"), "username,is_user_follow_business");
  await features.lookupInstagramProfile(h.env, "100001", NOW + DAY - 1);
  assert.equal(h.calls.length, 1);
  h.setResponder(() => Response.json({ username: "demo_reader", is_user_follow_business: false }));
  const refreshed = await features.lookupInstagramProfile(h.env, "100001", NOW + DAY);
  assert.equal(refreshed.isFollower, false);
  assert.equal(h.calls.length, 2);
  await features.lookupInstagramProfile({ ...h.env, IG_USER_ID: "900000000000101" }, "100001", NOW + DAY);
  assert.equal(h.calls.length, 3, "The same sender has separate follow status for each business account");
});

test("missing follow status and profile failures stay unknown, and errors never leak provider responses", async (t) => {
  const h = await fixture(t);
  h.setResponder(() => Response.json({ username: "demo_reader" }));
  const missing = await features.lookupInstagramProfile(h.env, "100002", NOW);
  assert.equal(missing.username, "demo_reader");
  assert.equal(missing.isFollower, null);
  assert.match(missing.error, /did not return/);
  h.setResponder(() => Response.json({ error: { code: 200, message: h.env.INSTAGRAM_ACCESS_TOKEN } }, { status: 403 }));
  const failed = await features.lookupInstagramProfile(h.env, "100002", NOW + 5 * 60 * 1000);
  assert.equal(failed.isFollower, null);
  assert.match(failed.error, /permissions/);
  assert.equal(JSON.stringify(failed).includes(h.env.INSTAGRAM_ACCESS_TOKEN), false);
  assert.equal(h.query("SELECT is_follower FROM instagram_profiles WHERE sender_id = '100002'").is_follower, null);
});

test("publishing uses the messenger profile API, verifies the result and ignores unrelated changes", async (t) => {
  const h = await fixture(t);
  await enableStarters(h);
  remoteStarters(h);
  const synced = await features.publishIceBreakers(h.env, undefined, NOW);
  assert.equal(synced.state, "synced", synced.error);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].url.pathname, `/v25.0/${h.env.IG_USER_ID}/messenger_profile`);
  assert.equal(h.calls[1].url.pathname, "/v25.0/me/messenger_profile");
  assert.deepEqual(h.calls[0].body.ice_breakers[0].call_to_actions, [
    { question: "Get the free guide", payload: "DM_REPLY__rule-1" },
    { question: "Ask a question", payload: "DM_REPLY__text-ask" },
  ]);
  const settings = await features.getDmFeatureSettings(h.db);
  settings.followerReply = "Thanks for following!";
  await features.saveDmFeatureSettings(h.db, settings);
  assert.equal((await features.getIceBreakersPublicationStatus(h.db)).state, "synced");
  settings.starters[0].title = "Send me the guide";
  await features.saveDmFeatureSettings(h.db, settings);
  assert.equal((await features.getIceBreakersPublicationStatus(h.db)).state, "pending");
  assert.equal(h.calls.length, 2, "Saving is separate from publishing");
  assert.equal((await features.publishIceBreakers(h.env, undefined, NOW + 1000)).state, "synced");
});

test("turning starters off deletes the profile field and verifies it is empty", async (t) => {
  const h = await fixture(t);
  await enableStarters(h);
  remoteStarters(h);
  await features.publishIceBreakers(h.env, undefined, NOW);
  const settings = await features.getDmFeatureSettings(h.db);
  settings.startersEnabled = false;
  await features.saveDmFeatureSettings(h.db, settings);
  const result = await features.publishIceBreakers(h.env, undefined, NOW + 1000);
  assert.equal(result.state, "synced");
  assert.equal(h.calls[2].method, "DELETE");
  assert.deepEqual(h.calls[2].body, { fields: ["ice_breakers"] });
});

test("a mutation without a boolean success flag still requires an exact Instagram readback", async (t) => {
  const h = await fixture(t);
  await enableStarters(h);
  let remote = [];
  h.setResponder((call) => {
    if (call.method === "POST") {
      remote = call.body.ice_breakers[0].call_to_actions;
      return Response.json({ result: "success" });
    }
    return Response.json({ data: [{ locale: "default", call_to_actions: remote }] });
  });
  assert.equal((await features.publishIceBreakers(h.env, undefined, NOW)).state, "synced");
  assert.equal(h.calls.length, 2);
  h.setResponder((call) => Response.json(call.method === "POST" ? { result: "success" } : { data: [] }));
  assert.equal((await features.publishIceBreakers(h.env, undefined, NOW + 1000)).state, "error");
});

test("unconfirmed starter writes and failed verification cannot show a successful publish", async (t) => {
  const h = await fixture(t);
  await enableStarters(h);
  h.setResponder(() => Response.json({ success: false, error: { message: h.env.INSTAGRAM_ACCESS_TOKEN } }));
  const rejected = await features.publishIceBreakers(h.env, undefined, NOW);
  assert.equal(rejected.state, "error");
  assert.equal(h.calls.length, 1);
  assert.equal(JSON.stringify(rejected).includes(h.env.INSTAGRAM_ACCESS_TOKEN), false);
  h.setResponder((call) => Response.json(call.method === "POST" ? { success: true } : { data: [] }));
  const mismatch = await features.publishIceBreakers(h.env, undefined, NOW + 1000);
  assert.equal(mismatch.state, "error");
  assert.match(mismatch.error, /not returned the updated starters/);
});

test("overlapping starter publishes share a lease and issue only one mutation", async (t) => {
  const h = await fixture(t);
  await enableStarters(h);
  let release;
  let started;
  const block = new Promise((resolve) => { release = resolve; });
  const posted = new Promise((resolve) => { started = resolve; });
  let remote = [];
  h.setResponder(async (call) => {
    if (call.method === "POST") {
      remote = call.body.ice_breakers[0].call_to_actions;
      started();
      await block;
      return Response.json({ success: true });
    }
    return Response.json({ data: [{ locale: "default", call_to_actions: remote }] });
  });
  const first = features.publishIceBreakers(h.env, undefined, NOW);
  await posted;
  const second = await features.publishIceBreakers(h.env, undefined, NOW);
  assert.equal(second.state, "pending");
  assert.equal(h.calls.length, 1);
  release();
  assert.equal((await first).state, "synced");
  assert.equal(h.calls.filter((call) => call.method === "POST").length, 1);
});

test("profile requests reject redirects and nonofficial hosts without exposing credentials", async (t) => {
  const h = await fixture(t);
  const mockedFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(init.redirect, "manual");
    return mockedFetch(input, init);
  };
  h.setResponder(() => new Response(null, { status: 302, headers: { location: `https://untrusted.example/${h.env.INSTAGRAM_ACCESS_TOKEN}` } }));
  const redirected = await features.lookupInstagramProfile(h.env, "100003", NOW);
  assert.equal(redirected.isFollower, null);
  assert.match(redirected.error, /unexpected redirect/);
  assert.equal(h.calls.length, 1);
  assert.equal(JSON.stringify(redirected).includes(h.env.INSTAGRAM_ACCESS_TOKEN), false);
  const badHost = await features.lookupInstagramProfile({ ...h.env, GRAPH_API_BASE: "https://untrusted.example/v25.0" }, "100004", NOW);
  assert.equal(badHost.isFollower, null);
  assert.match(badHost.error, /official/);
  assert.equal(h.calls.length, 1);
});

test("corrupted saved configuration disables DM tools until settings are repaired", async (t) => {
  const h = await fixture(t);
  await h.db.prepare("UPDATE automation_settings SET value = ? WHERE key = 'dm_features'").bind('{"startersEnabled":true}').run();
  const settings = await features.getDmFeatureSettings(h.db);
  assert.equal(settings.startersEnabled, false);
  assert.equal(settings.followerCheckEnabled, false);
  assert.deepEqual(settings.storyRules, []);
});

test("settings saved before migration 0008 still load, without the old DM keyword switch", async (t) => {
  const h = await fixture(t);
  const stored = JSON.parse(h.query("SELECT value FROM automation_settings WHERE key = 'dm_features'").value);
  assert.equal(stored.keywordRepliesEnabled, false, "The 0007 seed still holds the old field");
  await h.db.prepare("UPDATE automation_settings SET value = json_set(value, '$.keywordRepliesEnabled', json('true'), '$.followerCheckEnabled', json('true')) WHERE key = 'dm_features'").run();
  const settings = await features.getDmFeatureSettings(h.db);
  assert.equal(settings.followerCheckEnabled, true);
  assert.equal("keywordRepliesEnabled" in settings, false);
  await features.saveDmFeatureSettings(h.db, settings);
  assert.equal("keywordRepliesEnabled" in JSON.parse(h.query("SELECT value FROM automation_settings WHERE key = 'dm_features'").value), false);
});
