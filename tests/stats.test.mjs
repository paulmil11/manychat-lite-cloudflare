import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildWorker, commentPayload, createHarness, createRule, messagePayload } from "./worker-harness.mjs";

// Reply stats and overview figures, read from the rendered dashboard.
let built;
before(async () => { built = await buildWorker(); });
after(async () => { await built?.dispose(); });

async function fixture(t, overrides) {
  const harness = await createHarness(built.worker, overrides);
  t.after(() => harness.dispose());
  return { h: harness, cookie: await harness.login() };
}

function plainText(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

async function dashboard(h, cookie) {
  const response = await h.request("/admin", { headers: { cookie } });
  assert.equal(response.status, 200);
  return response.text();
}

async function replyStats(h, cookie) {
  const html = await dashboard(h, cookie);
  const section = html.match(/<section\b[^>]*\bid="performance"[^>]*>([\s\S]*?)<\/section>/)?.[1];
  assert.ok(section, "The dashboard must render the reply stats section");
  const headers = [...section.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((match) => plainText(match[1]));
  for (const required of ["Comment matches", "DM matches", "DMs sent", "Errors", "Last sent"]) {
    assert.ok(headers.includes(required), `Missing column: ${required}`);
  }
  const rows = [...section.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].flatMap((match) => {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cell[1]);
    if (!cells.length) return [];
    const title = cells[0].match(/<strong\b[^>]*>([\s\S]*?)<\/strong>/)?.[1] ?? cells[0];
    return [{
      label: plainText(title),
      text: plainText(match[1]),
      values: Object.fromEntries(headers.map((header, index) => [header, plainText(cells[index] ?? "")])),
      cells: Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])),
    }];
  });
  return {
    row(label) {
      const found = rows.filter((row) => row.label === label);
      assert.equal(found.length, 1, `Expected exactly one stats row for ${label}`);
      return found[0];
    },
    labels: rows.map((row) => row.label),
  };
}

function count(row, column) {
  const value = row.values[column].replace(/,/g, "");
  if (value === "—") return null;
  assert.match(value, /^\d+$/, `${column} must contain a number`);
  return Number(value);
}

function expectCounts(row, expected) {
  const columns = { comments: "Comment matches", dms: "DM matches", sent: "DMs sent", errors: "Errors" };
  for (const [key, column] of Object.entries(columns)) {
    if (key in expected) assert.equal(count(row, column), expected[key], `${row.label}: ${column}`);
  }
}

async function overview(h, cookie) {
  const html = await dashboard(h, cookie);
  const section = html.match(/<dl\b[^>]*class="figures"[^>]*>([\s\S]*?)<\/dl>/)?.[1];
  assert.ok(section, "The dashboard must render the overview figures");
  return Object.fromEntries([...section.matchAll(/<div class="figure[^"]*">([\s\S]*?)<\/div>/g)].map((match) => {
    const label = plainText(match[1].match(/<dt>([\s\S]*?)<\/dt>/)[1]);
    const value = Number(plainText(match[1].match(/<dd class="figure-value">([\s\S]*?)<\/dd>/)[1]).replace(/,/g, ""));
    const detail = plainText(match[1].match(/<dd class="figure-detail">([\s\S]*?)<\/dd>/)[1]);
    return [label, { value, detail }];
  }));
}

async function insertComment(h, id, status, overrides = {}) {
  const values = {
    matched: 1, ruleId: null, keyword: "GUIDE", label: null, text: "GUIDE",
    sentAt: null, error: status.includes("error") ? "Test send error" : null, ...overrides,
  };
  await h.db.prepare(`INSERT INTO comment_events
    (comment_id, comment_text, matched, matched_rule_id, matched_keyword, rule_label, status, error, received_at, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    id, values.text, values.matched, values.ruleId, values.keyword, values.label, status,
    values.error, "2026-09-01T00:00:00.000Z", values.sentAt,
  ).run();
}

async function insertMessage(h, id, status, overrides = {}) {
  const values = {
    replyKey: null, choice: null, text: "GUIDE", sentAt: null,
    error: status.includes("error") ? "Test send error" : null, ...overrides,
  };
  await h.db.prepare(`INSERT INTO message_events
    (message_id, sender_id, recipient_id, message_text, reply_key, matched_choice, status, error, received_at, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    id, "1234567890", h.env.IG_USER_ID, values.text, values.replyKey, values.choice, status,
    values.error, "2026-09-01T00:00:00.000Z", values.sentAt,
  ).run();
}

const GUIDE_RULE = { label: "Free guide", keywords: "GUIDE", reply_text: "Here is the guide." };
// The same automation, also listening for the keyword in DMs.
const GUIDE_RULE_WITH_DMS = { ...GUIDE_RULE, channels: ["comments", "dms"] };

test("every rule and custom reply has a stats row, including with no events", async (t) => {
  const { h, cookie } = await fixture(t);
  await createRule(h, cookie, GUIDE_RULE);
  const stats = await replyStats(h, cookie);
  assert.deepEqual(stats.labels, ["Example lead magnet", "Free guide", "Ask a question"]);
  expectCounts(stats.row("Free guide"), { comments: 0, dms: 0, sent: 0, errors: 0 });
  assert.match(stats.row("Free guide").text, /Keyword · Comments 0 /);
  assert.match(stats.row("Ask a question").text, /Custom reply · DMs/);
  assert.equal(count(stats.row("Ask a question"), "Comment matches"), null, "Custom replies never match comments");
  assert.doesNotMatch(stats.row("Free guide").cells["Last sent"], /<time\b/);
  assert.equal(h.calls.length, 0, "Loading stats must not call Instagram");
});

test("rule stats combine comments and DMs and count only real deliveries as sent", async (t) => {
  const { h, cookie } = await fixture(t);
  const guide = await createRule(h, cookie, GUIDE_RULE);
  const other = await createRule(h, cookie, { label: "Workshop", keywords: "WORKSHOP", reply_text: "Join the waitlist." });
  const key = `rule-${guide.id}`;
  await insertComment(h, "other-sent", "sent", { ruleId: other.id, label: "Workshop", keyword: "WORKSHOP", sentAt: "2026-09-02T12:00:00.000Z" });
  const otherBefore = (await replyStats(h, cookie)).row("Workshop").values;

  await insertComment(h, "c-sent", "sent", { ruleId: guide.id, sentAt: "2026-09-09T09:00:00.000Z" });
  await insertComment(h, "c-public-error", "sent_public_reply_error", { ruleId: guide.id, sentAt: "2026-09-10T10:00:00.000Z" });
  await insertComment(h, "c-send-error", "send_error", { ruleId: guide.id });
  await insertComment(h, "c-dry", "dry_run_matched", { ruleId: guide.id, sentAt: "2026-09-20T00:00:00.000Z" });
  await insertComment(h, "c-unmatched", "ignored_no_keyword", { matched: 0, keyword: null, text: "hello" });
  const lastSent = "2026-09-12T11:30:00.000Z";
  await insertMessage(h, "m-sent", "sent", { replyKey: key, choice: "Free guide", sentAt: lastSent });
  await insertMessage(h, "m-error", "send_error", { replyKey: key, choice: "Free guide" });
  await insertMessage(h, "m-dry", "dry_run_matched", { replyKey: key, choice: "Free guide", sentAt: "2026-09-21T00:00:00.000Z" });
  await insertMessage(h, "m-paused", "ignored_paused", { replyKey: key, choice: "Free guide" });
  await insertMessage(h, "m-unmatched", "ignored_no_match", { text: "hello" });
  await insertMessage(h, "m-custom", "sent", { replyKey: "text-ask", choice: "Ask a question", sentAt: "2026-09-22T00:00:00.000Z" });

  const stats = await replyStats(h, cookie);
  const row = stats.row("Free guide");
  expectCounts(row, { comments: 4, dms: 4, sent: 3, errors: 3 });
  assert.ok(row.cells["Last sent"].includes(`datetime="${lastSent}"`), "Last sent must be a delivery, not a later test match");
  expectCounts(stats.row("Ask a question"), { dms: 1, sent: 1, errors: 0 });
  assert.deepEqual(stats.row("Workshop").values, otherBefore);
  assert.equal(h.calls.length, 0);
});

test("the KEYWORD fallback gets its own row once it has matched a comment", async (t) => {
  const { h, cookie } = await fixture(t);
  assert.equal((await replyStats(h, cookie)).labels.includes("Fallback rule (KEYWORD)"), false);
  await h.webhook(commentPayload("fallback", "any guide?"));
  expectCounts((await replyStats(h, cookie)).row("Fallback rule (KEYWORD)"), { comments: 1, sent: 1, errors: 0 });
});

test("overview figures count every comment and DM and keep test matches apart from deliveries", async (t) => {
  const { h, cookie } = await fixture(t, { DRY_RUN: "true" });
  await createRule(h, cookie, GUIDE_RULE_WITH_DMS);
  await h.webhook(commentPayload("dry-comment", "GUIDE"));
  await h.webhook(commentPayload("plain-comment", "Nice post"));
  await h.webhook(messagePayload("dry-dm", "GUIDE"));
  const cards = await overview(h, cookie);
  assert.equal(cards["DMs sent"].value, 0);
  assert.equal(cards["DMs sent"].detail, "2 test matches");
  assert.equal(cards.Received.value, 3);
  assert.equal(cards.Received.detail, "2 comments · 1 DM");
  assert.equal(cards["Automations on"].detail, "of 2");
  assert.equal(cards["Automations on"].value, 1);
  assert.equal(cards.Errors.value, 0);
  assert.equal(h.calls.length, 0);
});

test("signed deliveries are counted once, including duplicate webhooks", async (t) => {
  const { h, cookie } = await fixture(t);
  await createRule(h, cookie, GUIDE_RULE_WITH_DMS);
  const comment = commentPayload("stats-comment", "GUIDE");
  const message = messagePayload("stats-message", "guide");
  await h.webhook(comment);
  await h.webhook(comment);
  await h.webhook(message);
  await h.webhook(message);
  expectCounts((await replyStats(h, cookie)).row("Free guide"), { comments: 1, dms: 1, sent: 2, errors: 0 });
  const cards = await overview(h, cookie);
  assert.equal(cards["DMs sent"].value, 2);
  assert.equal(cards["DMs sent"].detail, "All time · comments + DMs");
  assert.equal(h.calls.filter((call) => call.url.pathname.endsWith("/messages")).length, 2);
});
