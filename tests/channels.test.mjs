import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { buildWorker, commentPayload, createHarness, messagePayload } from "./worker-harness.mjs";

// Per-automation channels (comments, DMs, story replies) and migration 0008.
let built;
before(async () => { built = await buildWorker(); });
after(async () => { await built?.dispose(); });

async function fixture(t, overrides) {
  const h = await createHarness(built.worker, overrides);
  t.after(() => h.dispose());
  return { h, cookie: await h.login() };
}

function guideForm(channels, overrides = {}) {
  const form = new URLSearchParams({
    label: "Free guide", keywords: "GUIDE", reply_text: "Here’s the free guide.", public_reply_text: "Check your DMs",
    link_url: "https://example.test/guide", link_button_label: "Get the guide", active: "on", ...overrides,
  });
  for (const channel of channels) form.append("channels", channel);
  return form;
}

const post = (h, cookie, form, path = "/admin/rules") => h.request(path, { method: "POST", headers: { cookie }, body: form });
const messages = (h) => h.calls.filter((call) => call.method === "POST" && call.url.pathname.endsWith("/messages"));
const storyReply = (id, text) => ({
  object: "instagram",
  entry: [{ id: "test-instagram-account", messaging: [{
    sender: { id: "reader-account" }, recipient: { id: "test-instagram-account" }, timestamp: Date.now(),
    message: { mid: id, text, reply_to: { story: { id: "4242" } } },
  }] }],
});

test("an automation can answer DMs and story replies with its own message and button", async (t) => {
  const { h, cookie } = await fixture(t, { KEYWORD: "" });
  assert.equal((await post(h, cookie, guideForm(["dms", "stories"]))).status, 303);
  const rule = h.query("SELECT id, channels FROM rules WHERE label = 'Free guide'");
  assert.deepEqual(JSON.parse(rule.channels), ["dms", "stories"]);

  await h.webhook(messagePayload("dm-guide", "guide please"));
  await h.webhook(storyReply("story-guide", "GUIDE"));
  await h.webhook(commentPayload("comment-guide", "GUIDE please", "commenter"));

  for (const id of ["dm-guide", "story-guide"]) {
    assert.deepEqual(h.query("SELECT status, matched_choice, reply_key FROM message_events WHERE message_id = ?", id),
      { status: "sent", matched_choice: "Free guide", reply_key: `rule-${rule.id}` });
  }
  assert.equal(h.query("SELECT status FROM comment_events WHERE comment_id = 'comment-guide'").status, "ignored_no_keyword",
    "Comments are off for this automation");
  const sent = messages(h);
  assert.equal(sent.length, 2);
  for (const call of sent) {
    assert.equal(call.body.recipient.id, "reader-account");
    assert.equal(call.body.message.attachment.payload.text, "Here’s the free guide.");
    assert.equal(call.body.message.attachment.payload.buttons[0].url, "https://example.test/guide");
    assert.equal(call.body.message.attachment.payload.buttons[0].title, "Get the guide");
  }
  assert.equal(h.calls.filter((call) => call.url.pathname.endsWith("/replies")).length, 0, "No public reply outside comments");

  const html = await (await h.request("/admin", { headers: { cookie } })).text();
  assert.match(html, /<strong>Free guide<\/strong><span>DMs, Story replies<\/span>/);
  assert.match(html, /<span class="auto-sent">2 sent<\/span>/);
  assert.match(html, /Keyword · DMs, Story replies/);
});

test("public replies only go to comments", async (t) => {
  const { h, cookie } = await fixture(t);
  assert.equal((await post(h, cookie, guideForm(["comments", "dms"]))).status, 303);
  await h.webhook(commentPayload("comment", "GUIDE", "commenter"));
  await h.webhook(messagePayload("dm", "GUIDE"));
  assert.equal(messages(h).length, 2);
  const replies = h.calls.filter((call) => call.url.pathname.endsWith("/replies"));
  assert.equal(replies.length, 1);
  assert.equal(replies[0].url.pathname, "/v25.0/comment/replies");
});

test("the KEYWORD fallback answers comments only", async (t) => {
  const { h } = await fixture(t);
  await h.webhook(messagePayload("dm-fallback", "guide"));
  await h.webhook(storyReply("story-fallback", "guide"));
  assert.equal(h.query("SELECT status FROM message_events WHERE message_id = 'dm-fallback'").status, "ignored_no_match");
  assert.equal(h.query("SELECT status FROM message_events WHERE message_id = 'story-fallback'").status, "ignored_no_match");
  assert.equal(h.calls.length, 0);
});

test("a submission without channels means comments, and the picker needs at least one", async (t) => {
  const { h, cookie } = await fixture(t);
  assert.equal((await post(h, cookie, guideForm([]))).status, 303);
  const rule = h.query("SELECT id, channels FROM rules WHERE label = 'Free guide'");
  assert.deepEqual(JSON.parse(rule.channels), ["comments"]);

  const nothingChecked = guideForm([""], { label: "Nowhere", keywords: "NOWHERE" });
  const rejected = await post(h, cookie, nothingChecked);
  assert.equal(rejected.status, 400);
  assert.match(await rejected.text(), /Choose where the automation listens/);

  const moved = guideForm(["", "dms"]);
  moved.append("action", "save");
  assert.equal((await post(h, cookie, moved, `/admin/rules/${rule.id}`)).status, 303);
  assert.deepEqual(JSON.parse(h.query("SELECT channels FROM rules WHERE id = ?", rule.id).channels), ["dms"]);

  const withoutPicker = guideForm([], { label: "Renamed" });
  withoutPicker.append("action", "save");
  assert.equal((await post(h, cookie, withoutPicker, `/admin/rules/${rule.id}`)).status, 303);
  assert.deepEqual(JSON.parse(h.query("SELECT channels FROM rules WHERE id = ?", rule.id).channels), ["dms"],
    "Editing without the picker keeps the current channels");
});

test("a failed comment can't be retried once its automation stops listening on comments", async (t) => {
  const { h, cookie } = await fixture(t);
  assert.equal((await post(h, cookie, guideForm(["comments"], { public_reply_text: "" }))).status, 303);
  const rule = h.query("SELECT id FROM rules WHERE label = 'Free guide'");
  h.setResponder(() => new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 503 }));
  await h.webhook(commentPayload("failed", "GUIDE", "commenter"));
  assert.equal(h.query("SELECT status FROM comment_events WHERE comment_id = 'failed'").status, "send_error");
  const dmsOnly = guideForm(["dms"]);
  dmsOnly.append("action", "save");
  assert.equal((await post(h, cookie, dmsOnly, `/admin/rules/${rule.id}`)).status, 303);
  h.setResponder(() => Response.json({ message_id: "ok" }));
  const retry = await h.postForm("/admin/events/failed/retry", {}, cookie);
  assert.equal(retry.status, 400);
  assert.match(await retry.text(), /no longer listens on comments/);
  assert.equal(messages(h).length, 1);
});

test("the same keyword can be used on different channels, but not twice on one", async (t) => {
  const { h, cookie } = await fixture(t);
  assert.equal((await post(h, cookie, guideForm(["comments"]))).status, 303);
  assert.equal((await post(h, cookie, guideForm(["dms"], { label: "Guide by DM" }))).status, 303);
  const clash = await post(h, cookie, guideForm(["stories", "dms"], { label: "Guide again" }));
  assert.equal(clash.status, 400);
  assert.match(await clash.text(), /GUIDE is already used by “Guide by DM” for DMs/);
  const both = await post(h, cookie, guideForm(["comments", "dms", "stories"], { label: "Guide everywhere" }));
  assert.equal(both.status, 400);
  assert.match(await both.text(), /GUIDE is already used by “Free guide” for comments\./);
  assert.equal((await post(h, cookie, guideForm(["stories"], { label: "Guide by story" }))).status, 303);

  const dmRule = h.query("SELECT id FROM rules WHERE label = 'Guide by DM'");
  const moveToComments = guideForm(["comments", "dms"], { label: "Guide by DM" });
  moveToComments.append("action", "save");
  assert.equal((await post(h, cookie, moveToComments, `/admin/rules/${dmRule.id}`)).status, 400);
});

// Applies 0001-0007, sets up an older install, then applies 0008 and later.
async function migrate({ settings }) {
  const sqlite = new DatabaseSync(":memory:");
  const files = (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort();
  const before = files.filter((name) => name < "0008");
  for (const file of before) sqlite.exec(await readFile(join("migrations", file), "utf8"));
  if (settings === null) sqlite.exec("DELETE FROM automation_settings WHERE key = 'dm_features'");
  else if (settings !== undefined) sqlite.prepare("UPDATE automation_settings SET value = ? WHERE key = 'dm_features'").run(settings);
  sqlite.prepare(`INSERT INTO rules (label, keywords, reply_text, active, created_at, updated_at)
    VALUES ('Free guide', '["GUIDE"]', 'Here is the guide.', 1, 'now', 'now')`).run();
  for (const file of files.filter((name) => name >= "0008")) sqlite.exec(await readFile(join("migrations", file), "utf8"));
  const channels = sqlite.prepare("SELECT label, channels FROM rules ORDER BY id").all().map((row) => [row.label, JSON.parse(row.channels)]);
  sqlite.close();
  return channels;
}

test("migration 0008 keeps each install's DM keyword setting", async () => {
  const seeded = JSON.parse((await readFile("migrations/0007_dm_features.sql", "utf8")).match(/'(\{"revision":"initial"[^']*)'/)[1]);
  assert.equal(seeded.keywordRepliesEnabled, false);

  assert.deepEqual(await migrate({}), [["Example lead magnet", ["comments"]], ["Free guide", ["comments"]]],
    "Fresh installs had DM keyword replies off, so automations keep answering comments only");
  assert.deepEqual(await migrate({ settings: JSON.stringify({ ...seeded, keywordRepliesEnabled: true }) }),
    [["Example lead magnet", ["comments", "dms", "stories"]], ["Free guide", ["comments", "dms", "stories"]]],
    "With the old switch on, automations keep answering DMs and story replies");
  assert.deepEqual(await migrate({ settings: JSON.stringify({ ...seeded, keywordRepliesEnabled: false }) }),
    [["Example lead magnet", ["comments"]], ["Free guide", ["comments"]]]);
  assert.deepEqual(await migrate({ settings: null }), [["Example lead magnet", ["comments"]], ["Free guide", ["comments"]]],
    "Missing settings meant the switch was off");
  assert.deepEqual(await migrate({ settings: "not json" }), [["Example lead magnet", ["comments"]], ["Free guide", ["comments"]]],
    "Unreadable settings meant the switch was off, and do not break the migration");
});

test("after the migration, an automation from an install with DM keywords on still answers DMs and story replies", async (t) => {
  const { h } = await fixture(t);
  const now = new Date().toISOString();
  await h.db.prepare(`INSERT INTO rules (label, channels, keywords, reply_text, active, created_at, updated_at)
    VALUES ('Free guide', '["comments","dms","stories"]', '["GUIDE"]', 'Here is the guide.', 1, ?, ?)`).bind(now, now).run();
  await h.webhook(messagePayload("dm", "GUIDE"));
  await h.webhook(storyReply("story", "guide please"));
  assert.equal(h.query("SELECT status FROM message_events WHERE message_id = 'dm'").status, "sent");
  assert.equal(h.query("SELECT status FROM message_events WHERE message_id = 'story'").status, "sent");
  assert.equal(messages(h).length, 2);
});
