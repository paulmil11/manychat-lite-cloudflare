import assert from "node:assert/strict";
import { test, after, before } from "node:test";
import { buildModule, buildWorker, createHarness, createRule } from "./worker-harness.mjs";

// The New automation dialog, rule validation and keyword conflicts.
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
  return { h, cookie: await h.login() };
}

const ruleForm = (overrides = {}) => ({
  label: "Free guide", keywords: "GUIDE", reply_text: "Here’s the free guide.",
  public_reply_text: "", link_url: "https://example.test/guide", link_button_label: "Get the guide", active: "on",
  ...overrides,
});

const rulesCount = (h) => h.query("SELECT COUNT(*) AS count FROM rules").count;

function attribute(markup, name) {
  return JSON.parse(markup.match(new RegExp(`${name}="([^"]*)"`))[1]
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
}

test("the new automation form offers templates, a channel picker, a tester, a preview, and the keywords in use", async (t) => {
  const { h, cookie } = await fixture(t);
  await createRule(h, cookie, { label: "Workshop", keywords: "WORKSHOP, Join", reply_text: "Join the waitlist.", channels: ["comments", "stories"] });
  await createRule(h, cookie, { label: "Paused promo", keywords: "PROMO", reply_text: "Here’s the promo.", active: "" });
  const html = await (await h.request("/admin", { headers: { cookie } })).text();
  const dialog = html.match(/<dialog id="new-rule"[\s\S]*?<\/dialog>/)?.[0];
  assert.ok(dialog);
  for (const field of ["label", "keywords", "reply_text", "public_reply_text", "link_url", "link_button_label", "active"]) {
    assert.match(dialog, new RegExp(`name="${field}"`), field);
  }
  for (const label of ["Book or product", "Free guide", "Event or workshop", "Waitlist", "Podcast episode", "Blank"]) {
    assert.match(dialog, new RegExp(`class="template"[^>]*>${label}</button>`), label);
  }
  assert.match(dialog, /Listen for it in/);
  assert.deepEqual([...dialog.matchAll(/type="checkbox" name="channels" value="(\w+)"/g)].map((match) => match[1]), ["comments", "dms", "stories"]);
  assert.match(dialog, /type="checkbox" name="channels" value="comments" checked/, "New automations start on comments");
  assert.match(dialog, /id="nr-test"/);
  assert.match(dialog, /id="nrp-message"/);
  assert.match(dialog, /id="nrp-as-dm"/, "The preview has a DM and story variant");
  assert.match(dialog, /id="nr-message-count">0 \/ 1,000</);
  assert.match(dialog, /live in <a href="#settings" data-close-dialog>Settings<\/a>/);
  assert.match(dialog, /<strong>test_owner<\/strong> <span id="nrp-public">/, "The public reply preview uses the account name");
  assert.deepEqual(attribute(dialog, "data-suggested"), ["Sent you the link", "Check your DMs", "Just sent it over", "Dropped it in your DMs", "On it, check your DMs"]);
  const taken = attribute(dialog, "data-taken");
  assert.deepEqual(taken.workshop, [{ label: "Workshop", channels: ["comments", "stories"] }]);
  assert.deepEqual(taken.join, [{ label: "Workshop", channels: ["comments", "stories"] }]);
  assert.equal(taken.promo, undefined, "Paused automations don’t block a keyword");
  assert.equal(taken.guide, undefined, "The paused example automation doesn’t block GUIDE");
  assert.match(html, /const keywordMatch = \(function keywordMatch\w*\(/, "The tester embeds the server matcher");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script), "The dashboard script parses");
  const embedded = new Function(`return ${script.match(/const keywordMatch = (\(function[\s\S]*?\n\}\));/)[1]};`)();
  assert.deepEqual(embedded("guide please", "GUIDE"), { match: true, reason: "match" });
  assert.deepEqual(embedded("I loved your guide last week", "GUIDE"), { match: false, reason: "extra_words" });

  const editForms = [...html.matchAll(/<form action="\/admin\/rules\/\d+"[\s\S]*?<\/form>/g)].map((match) => match[0]);
  assert.equal(editForms.length, 3);
  for (const form of editForms) {
    assert.match(form, /<input type="hidden" name="channels" value="">/);
    assert.equal((form.match(/type="checkbox" name="channels"/g) ?? []).length, 3);
  }
  assert.ok(editForms.some((form) => /value="stories" checked/.test(form) && /value="dms" >/.test(form)));
});

test("the matcher works on its own, so the browser tester runs the same rule as the server", () => {
  const { keywordMatch } = matcher.module;
  const embedded = new Function(`return (${keywordMatch.toString()});`)();
  const cases = [
    ["GUIDE please", "guide"], ["@yourhandle I like your thinking on this", "yourhandle"],
    ["I loved your guide last week, it was great", "guide"], ["What is the guide about exactly though", "guide"],
    ["#guide", "guide"], ["free guide", "free guide"], ["audio_book", "audio"], ["Ｇｕｉｄｅ", "guide"],
  ];
  for (const [text, keyword] of cases) assert.deepEqual(embedded(text, keyword), keywordMatch(text, keyword), text);
  assert.deepEqual(keywordMatch("I loved your guide last week", "guide"), { match: false, reason: "extra_words" });
  assert.deepEqual(keywordMatch("nothing here", "guide"), { match: false, reason: "missing" });
  assert.deepEqual(keywordMatch("Ｇｕｉｄｅ", "guide"), { match: true, reason: "match" }, "Full-width letters are normalized");
});

test("a keyword another active automation uses on the same channel is rejected, case-insensitively", async (t) => {
  const { h, cookie } = await fixture(t);
  assert.equal((await h.postForm("/admin/rules", ruleForm(), cookie)).status, 303);
  const before = rulesCount(h);
  const clash = await h.postForm("/admin/rules", ruleForm({ label: "Guide again", keywords: "books, guide" }), cookie);
  assert.equal(clash.status, 400);
  assert.match(await clash.text(), /GUIDE is already used by “Free guide” for comments/);
  assert.equal(rulesCount(h), before);

  const created = h.query("SELECT id FROM rules WHERE label = 'Free guide'");
  const renamed = await h.postForm(`/admin/rules/${created.id}`, { ...ruleForm({ label: "Renamed guide" }), action: "save" }, cookie);
  assert.equal(renamed.status, 303, "Saving a rule with its own keyword is not a conflict");

  assert.equal((await h.postForm("/admin/rules", ruleForm({ label: "Books", keywords: "BOOKS" }), cookie)).status, 303);
  const books = h.query("SELECT id FROM rules WHERE label = 'Books'");
  const moved = await h.postForm(`/admin/rules/${books.id}`, { ...ruleForm({ label: "Books", keywords: "Guide" }), action: "save" }, cookie);
  assert.equal(moved.status, 400);
  assert.match(await moved.text(), /“Renamed guide”/);
});

test("paused automations may share a keyword until one is turned on", async (t) => {
  const { h, cookie } = await fixture(t);
  assert.equal((await h.postForm("/admin/rules", ruleForm(), cookie)).status, 303);
  const paused = await h.postForm("/admin/rules", ruleForm({ label: "Winter guide", active: "" }), cookie);
  assert.equal(paused.status, 303, await paused.text());
  const winter = h.query("SELECT id, active FROM rules WHERE label = 'Winter guide'");
  assert.equal(winter.active, 0);
  const toggled = await h.postForm(`/admin/rules/${winter.id}`, { action: "toggle" }, cookie);
  assert.equal(toggled.status, 400);
  assert.match(await toggled.text(), /pause “Free guide” first/);
  assert.equal(h.query("SELECT active FROM rules WHERE id = ?", winter.id).active, 0);
  const savedOn = await h.postForm(`/admin/rules/${winter.id}`, { ...ruleForm({ label: "Winter guide" }), action: "save" }, cookie);
  assert.equal(savedOn.status, 400);

  const summer = h.query("SELECT id FROM rules WHERE label = 'Free guide'");
  assert.equal((await h.postForm(`/admin/rules/${summer.id}`, { action: "toggle" }, cookie)).status, 303);
  assert.equal((await h.postForm(`/admin/rules/${winter.id}`, { action: "toggle" }, cookie)).status, 303);
  assert.equal(h.query("SELECT active FROM rules WHERE id = ?", winter.id).active, 1);
});

test("DM messages longer than Instagram allows are rejected before they can fail on a real comment", async (t) => {
  const { h, cookie } = await fixture(t);
  const withButton = await h.postForm("/admin/rules", ruleForm({ reply_text: "x".repeat(641) }), cookie);
  assert.equal(withButton.status, 400);
  assert.match(await withButton.text(), /640 characters when it has a button/);
  const plain = await h.postForm("/admin/rules", ruleForm({ keywords: "PLAIN", reply_text: "x".repeat(1001), link_url: "", link_button_label: "" }), cookie);
  assert.equal(plain.status, 400);
  assert.match(await plain.text(), /1,000 characters/);
  assert.equal((await h.postForm("/admin/rules", ruleForm({ keywords: "BUTTON", reply_text: "x".repeat(640) }), cookie)).status, 303);
  assert.equal((await h.postForm("/admin/rules", ruleForm({ keywords: "LONG", reply_text: "x".repeat(1000), link_url: "", link_button_label: "" }), cookie)).status, 303);

  const rule = h.query("SELECT id FROM rules WHERE keywords LIKE '%LONG%'");
  const edited = await h.postForm(`/admin/rules/${rule.id}`, { ...ruleForm({ keywords: "LONG", reply_text: "y".repeat(1000) }), action: "save" }, cookie);
  assert.equal(edited.status, 400, "Adding a button to a long message hits the 640 limit");
  assert.equal(h.calls.length, 0);
});

test("keywords that can never match and half-finished buttons are rejected", async (t) => {
  const { h, cookie } = await fixture(t);
  const before = rulesCount(h);
  for (const [fields, message] of [
    [{ keywords: "@yourhandle" }, /can never match/],
    [{ keywords: "!!!" }, /can never match/],
    [{ keywords: "one two three four five six seven eight nine" }, /at most eight words/],
    [{ link_url: "" }, /both a button link and button label/],
    [{ link_button_label: "" }, /both a button link and button label/],
    [{ link_url: "http://example.test/guide" }, /https/],
  ]) {
    const response = await h.postForm("/admin/rules", ruleForm(fields), cookie);
    assert.equal(response.status, 400, JSON.stringify(fields));
    assert.match(await response.text(), message);
  }
  assert.equal(rulesCount(h), before);
});
