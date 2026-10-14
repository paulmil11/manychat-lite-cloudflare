import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildWorker, commentPayload, createHarness, createRule, messagePayload } from "./worker-harness.mjs";

// The Sent DMs page (/admin/sent) and its live JSON feed.
let built;
before(async () => { built = await buildWorker(); });
after(async () => { await built?.dispose(); });

async function fixture(t, overrides) {
  const h = await createHarness(built.worker, overrides);
  t.after(() => h.dispose());
  const cookie = await h.login();
  await createRule(h, cookie, { label: "Newsletter", keywords: "MAIL", reply_text: "Here is the newsletter." });
  await createRule(h, cookie, { label: "Free guide", keywords: "GUIDE", reply_text: "Here is the guide.", channels: ["comments", "dms"] });
  return { h, cookie };
}

function rowsOf(html) {
  return [...html.matchAll(/<article class="dm-row"[\s\S]*?<\/article>/g)].map((match) => match[0]);
}

async function sentPage(h, cookie) {
  const response = await h.request("/admin/sent", { headers: { cookie } });
  assert.equal(response.status, 200);
  return response.text();
}

test("the sent DMs page requires a dashboard login", async (t) => {
  const { h } = await fixture(t);
  const page = await h.request("/admin/sent");
  assert.equal(page.status, 303);
  assert.equal(page.headers.get("location"), "/admin");
  const feed = await h.request("/admin/sent?format=json");
  assert.equal(feed.status, 401);
  assert.equal(h.calls.length, 0);
});

test("only outgoing DMs are listed, with what the person did and said", async (t) => {
  const { h, cookie } = await fixture(t);
  await h.webhook(commentPayload("comment-mail", "MAIL me the link", "sample_reader"));
  await h.webhook(commentPayload("comment-plain", "Great post", "quiet_reader"));
  await h.webhook(commentPayload("comment-mention", "@test_owner I like your thinking on this", "chatty_reader"));
  await h.webhook(messagePayload("dm-hello", "hello there"));
  await h.webhook(messagePayload("dm-guide", "guide please"));

  const html = await sentPage(h, cookie);
  assert.match(html, /<h1>Sent DMs<\/h1>/);
  assert.match(html, /aria-current="page">Sent DMs</);
  const rows = rowsOf(html);
  assert.equal(rows.length, 2, "Unmatched comments and DMs are not sent DMs");

  const comment = rows.find((row) => row.includes("@sample_reader"));
  assert.ok(comment);
  assert.match(comment, /href="https:\/\/www\.instagram\.com\/sample_reader\/"/);
  assert.match(comment, /commented/);
  assert.match(comment, /<mark>MAIL<\/mark> me the link/);
  assert.match(comment, /matched MAIL/);
  assert.match(comment, /Sent Newsletter/);
  assert.doesNotMatch(comment, /class="partial"/);
  assert.match(comment, /data-kind="comment"/);

  const dm = rows.find((row) => row.includes("messaged you"));
  assert.ok(dm);
  assert.match(dm, /data-kind="dm"/);
  assert.match(dm, /Sent Free guide/);
  assert.match(dm, /<mark>guide<\/mark> please/, "A typed DM highlights the automation keyword it matched");
  assert.doesNotMatch(html, /hello there|Great post|chatty_reader/);
  assert.match(html, /<strong>2<\/strong> DMs sent in the last 24 hours/);
  assert.match(html, /data-filter="failed"/);
  assert.match(html, /id="sent-search"/);
  assert.match(html, /setInterval\(poll, 15000\)/);
  assert.match(html, /document\.hidden/, "Polling pauses while the tab is hidden");
  assert.doesNotThrow(() => new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1]), "The page script parses");
});

test("DMs from starters, story replies and links say how they started", async (t) => {
  const { h, cookie } = await fixture(t);
  const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
  const insert = (id, source, minutes, extra = {}) => h.db.prepare(`INSERT INTO message_events
    (message_id, sender_id, message_text, source, referral_ref, quick_reply_payload, reply_key, matched_choice, status, sender_username, received_at, sent_at)
    VALUES (?, '1234567890', ?, ?, ?, ?, 'text-ask', 'Ask a question', 'sent', ?, ?, ?)`)
    .bind(id, extra.text ?? "", source, extra.ref ?? null, extra.payload ?? null, extra.username ?? null, minutesAgo(minutes), minutesAgo(minutes)).run();
  await insert("starter", "starter", 30, { text: "Ask a question", payload: "DM_REPLY__text-ask", username: "starter_fan" });
  await insert("story", "story_reply", 10, { text: "Love this", username: "story_fan" });
  await insert("link", "referral", 20, { ref: "text-ask__newsletter" });
  const html = await sentPage(h, cookie);
  assert.deepEqual(rowsOf(html).map((row) => row.match(/data-id="dm:([^"]+)"/)[1]), ["story", "link", "starter"], "Newest first");
  assert.match(html, /tapped a conversation starter/);
  assert.match(html, /replied to your story/);
  assert.match(html, /opened your DM link from newsletter/);
  assert.match(html, /Instagram user …7890/, "A sender without a username shows the end of their ID");
  assert.match(html, /Sent Ask a question/);
});

test("older sends where the keyword hit part of a word are flagged", async (t) => {
  const { h, cookie } = await fixture(t);
  const now = new Date().toISOString();
  await h.db.prepare(`INSERT INTO comment_events (comment_id, username, comment_text, matched, status, matched_keyword, rule_label, received_at, sent_at)
    VALUES ('old-email', 'old_reader', 'I emailed you last week', 1, 'sent', 'mail', 'Newsletter', ?, ?)`).bind(now, now).run();
  const [row] = rowsOf(await sentPage(h, cookie));
  assert.match(row, /e<mark>mail<\/mark>ed you/);
  assert.match(row, /inside “emailed”/);
});

test("whole-word keyword matches are not flagged as partial", async (t) => {
  const { h, cookie } = await fixture(t);
  await h.webhook(commentPayload("comment-guide", "GUIDE please", "collector"));
  const [row] = rowsOf(await sentPage(h, cookie));
  assert.match(row, /<mark>GUIDE<\/mark> please/);
  assert.doesNotMatch(row, /class="partial"/);
});

test("failed sends are shown and counted separately", async (t) => {
  const { h, cookie } = await fixture(t);
  h.setResponder(() => new Response(JSON.stringify({ error: { message: "User cannot receive messages" } }), {
    status: 400, headers: { "content-type": "application/json" },
  }));
  await h.webhook(commentPayload("comment-failed", "guide", "unreachable"));
  await h.webhook(messagePayload("dm-failed", "GUIDE"));
  const html = await sentPage(h, cookie);
  const rows = rowsOf(html);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.match(row, /data-failed="1"/);
    assert.match(row, /Didn’t send/);
    assert.match(row, /User cannot receive messages/);
  }
  assert.match(html, /<strong>0<\/strong> DMs sent in the last 24 hours · <span class="failed-count">2 didn’t send<\/span>/);
});

test("a delivered DM whose public reply failed counts as sent and says so", async (t) => {
  const { h, cookie } = await fixture(t);
  await h.db.prepare("UPDATE rules SET public_reply_text = 'Check your DMs' WHERE label = 'Free guide'").run();
  h.setResponder((call) => call.url.pathname.endsWith("/replies")
    ? new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 500 })
    : Response.json({ message_id: "ok" }));
  await h.webhook(commentPayload("public-failed", "GUIDE", "reader"));
  const html = await sentPage(h, cookie);
  const [row] = rowsOf(html);
  assert.match(row, /data-failed="0"/);
  assert.match(row, /DM sent\. The public comment reply failed\./);
  assert.match(html, /<strong>1<\/strong> DM sent in the last 24 hours/);
});

test("user-supplied text is escaped in the page and in the live feed", async (t) => {
  const { h, cookie } = await fixture(t);
  await h.webhook(commentPayload("comment-xss", "guide <script>", "a<b>"));
  const html = await sentPage(h, cookie);
  assert.doesNotMatch(html, /guide <script>/);
  assert.match(html, /<mark>guide<\/mark> &lt;script&gt;/);
  assert.match(html, /@a&lt;b&gt;/);
  assert.doesNotMatch(html, /instagram\.com\/a</, "Invalid usernames are not linked");

  const feed = await h.request("/admin/sent?format=json", { headers: { cookie } });
  assert.equal(feed.status, 200);
  assert.equal(feed.headers.get("cache-control"), "no-store");
  const data = await feed.json();
  assert.deepEqual(Object.keys(data).sort(), ["rows", "summary"]);
  assert.equal(rowsOf(data.rows).length, 1);
  assert.doesNotMatch(data.rows, /<script>/);
  assert.match(data.summary, /<strong>1<\/strong> DM sent/);
});

test("test mode says nothing is being sent", async (t) => {
  const { h, cookie } = await fixture(t, { DRY_RUN: "true" });
  await h.webhook(commentPayload("dry", "GUIDE", "reader"));
  const html = await sentPage(h, cookie);
  assert.match(html, /Test mode is on, so nothing is being sent/);
  assert.equal(rowsOf(html).length, 0, "Test matches are not sent DMs");
  assert.match(html, /No DMs sent yet\./);
  assert.equal(h.calls.length, 0);
});

test("polling reads from the received_at indexes instead of scanning by status", async (t) => {
  const { h } = await fixture(t);
  for (const table of ["comment_events", "message_events"]) {
    const plan = await h.db.prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE +status IN ('sent', 'send_error') ORDER BY received_at DESC LIMIT 100`
    ).all();
    const detail = plan.results.map((row) => row.detail).join(" | ");
    assert.match(detail, new RegExp(`idx_${table}_received_at`), detail);
    assert.doesNotMatch(detail, /TEMP B-TREE/, detail);
  }
});
