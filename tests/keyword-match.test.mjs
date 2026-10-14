import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildModule, buildWorker, commentPayload, createHarness, createRule, messagePayload } from "./worker-harness.mjs";

// The strict matching rule (src/keyword-match.ts), end to end through signed webhooks.
let built;
let matcher;
before(async () => {
  built = await buildWorker();
  matcher = await buildModule("src/keyword-match.ts");
});
after(async () => {
  await built?.dispose();
  await matcher?.dispose();
});

async function fixture(t) {
  const h = await createHarness(built.worker);
  t.after(() => h.dispose());
  const cookie = await h.login();
  await createRule(h, cookie, { label: "Free guide", keywords: "GUIDE", reply_text: "Here is the free guide.", channels: ["comments", "dms", "stories"] });
  await createRule(h, cookie, { label: "Reading list", keywords: "BOOKS", reply_text: "Here is my reading list." });
  await createRule(h, cookie, { label: "Newsletter", keywords: "MAIL", reply_text: "Here is the newsletter." });
  await createRule(h, cookie, { label: "Brand kit", keywords: "YOURHANDLE", reply_text: "Here is the brand kit." });
  return h;
}

const commentRow = (h, id) => h.query("SELECT status, matched_keyword FROM comment_events WHERE comment_id = ?", id);
const messageRow = (h, id) => h.query("SELECT status, matched_choice FROM message_events WHERE message_id = ?", id);
const sends = (h) => h.calls.filter((call) => call.method === "POST" && call.url.pathname.endsWith("/messages")).length;

test("the matcher accepts short requests and rejects conversation", () => {
  const { keywordMatch, isBasicallyKeyword } = matcher.module;
  const yes = [
    ["GUIDE", "guide"], ["guide please 🙏", "guide"], ["#guide", "guide"], ["Please send me the BOOKS links", "books"],
    ["Mail!", "mail"], ["@yourhandle guide please", "guide"], ["free guide", "guide"], ["Free guide", "free guide"],
    ["can I get the guide pls", "guide"], ["audio_book", "audio_book"],
  ];
  for (const [text, keyword] of yes) assert.equal(isBasicallyKeyword(text, keyword), true, `${text} / ${keyword}`);
  const no = [
    ["@yourhandle I like your thinking on this", "yourhandle", "missing"],
    ["What are your favorite books on personal finance?", "books", "extra_words"],
    ["I emailed you last week", "mail", "missing"],
    ["I loved your guide last week, it was great", "guide", "too_long"],
    ["Guidelines please", "guide", "missing"],
    ["audio_book", "audio", "missing"],
    ["", "guide", "missing"],
    ["guide", "", "missing"],
  ];
  for (const [text, keyword, reason] of no) assert.deepEqual(keywordMatch(text, keyword), { match: false, reason }, `${text} / ${keyword}`);
});

test("comments trigger only when they are basically just the keyword", async (t) => {
  const h = await fixture(t);
  const triggers = ["GUIDE", "guide please 🙏", "#guide", "Please send the BOOKS links", "Mail!", "@yourhandle guide please", "free guide"];
  for (const [index, text] of triggers.entries()) {
    await h.webhook(commentPayload(`yes-${index}`, text, `reader${index}`));
    assert.equal(commentRow(h, `yes-${index}`).status, "sent", text);
  }
  assert.equal(commentRow(h, "yes-3").matched_keyword, "BOOKS");
  const conversation = [
    "@yourhandle I like your thinking on this",
    "What are your favorite books on personal finance?",
    "I emailed you last week",
    "I loved your guide last week, it was great",
    "Guidelines please",
  ];
  for (const [index, text] of conversation.entries()) {
    await h.webhook(commentPayload(`no-${index}`, text, `talker${index}`));
    assert.deepEqual(commentRow(h, `no-${index}`), { status: "ignored_no_keyword", matched_keyword: null }, text);
  }
  assert.equal(sends(h), triggers.length);
});

test("DMs and story replies use the same rule", async (t) => {
  const h = await fixture(t);
  const story = (id, text) => ({
    object: "instagram",
    entry: [{ id: "test-instagram-account", messaging: [{
      sender: { id: "reader-account" }, recipient: { id: "test-instagram-account" }, timestamp: Date.now(),
      message: { mid: id, text, reply_to: { story: { id: "777" } } },
    }] }],
  });
  await h.webhook(messagePayload("dm-yes", "guide please"));
  await h.webhook(messagePayload("dm-no", "I loved your guide, is there a part two?"));
  await h.webhook(story("story-yes", "GUIDE 🙌"));
  await h.webhook(story("story-no", "Loved this. Which guide should I start with?"));
  assert.deepEqual(messageRow(h, "dm-yes"), { status: "sent", matched_choice: "Free guide" });
  assert.deepEqual(messageRow(h, "story-yes"), { status: "sent", matched_choice: "Free guide" });
  assert.equal(messageRow(h, "dm-no").status, "ignored_no_match");
  assert.equal(messageRow(h, "story-no").status, "ignored_no_match");
  assert.equal(sends(h), 2);
});

test("story rule keywords follow the same rule", async (t) => {
  const h = await fixture(t);
  await h.db.prepare("UPDATE rules SET channels = '[\"comments\"]'").run();
  await h.db.prepare("UPDATE automation_settings SET value = json_set(value, '$.storyRules', json(?)) WHERE key = 'dm_features'")
    .bind(JSON.stringify([{ id: "s", label: "Any GUIDE reply", storyId: "", storyUrl: "", keyword: "GUIDE", reply: "text-ask", enabled: true }])).run();
  const story = (id, text) => ({
    object: "instagram",
    entry: [{ id: "test-instagram-account", messaging: [{
      sender: { id: "reader-account" }, recipient: { id: "test-instagram-account" }, timestamp: Date.now(),
      message: { mid: id, text, reply_to: { story: { id: "888" } } },
    }] }],
  });
  await h.webhook(story("rule-yes", "send the guide please"));
  await h.webhook(story("rule-no", "Loved this guide, which camera do you use?"));
  assert.deepEqual(messageRow(h, "rule-yes"), { status: "sent", matched_choice: "Ask a question" });
  assert.equal(messageRow(h, "rule-no").status, "ignored_no_match");
});
