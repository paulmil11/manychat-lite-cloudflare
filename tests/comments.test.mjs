import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildWorker, commentPayload, createHarness, createRule } from "./worker-harness.mjs";

const GUIDE_RULE = {
  label: "Free guide",
  keywords: "GUIDE, checklist",
  reply_text: "Thanks for commenting! Here is the free guide.",
  link_url: "https://example.com/guide",
  link_button_label: "Open guide",
};

let built;
before(async () => { built = await buildWorker(); });
after(async () => { await built?.dispose(); });

async function fixture(t, overrides) {
  const harness = await createHarness(built.worker, overrides);
  t.after(() => harness.dispose());
  return harness;
}

function privateCalls(harness) {
  return harness.calls.filter((call) => call.url.pathname.endsWith("/messages"));
}

function publicCalls(harness) {
  return harness.calls.filter((call) => call.url.pathname.endsWith("/replies"));
}

function eventRow(harness, commentId) {
  return harness.query("SELECT * FROM comment_events WHERE comment_id = ?", commentId);
}

test("a signed keyword comment sends one private reply with a link button, even when delivered twice", async (t) => {
  const h = await fixture(t);
  const cookie = await h.login();
  await createRule(h, cookie, GUIDE_RULE);
  const payload = commentPayload("comment-guide", "Please send the guide!");
  const responses = await Promise.all([h.webhook(payload), h.webhook(payload)]);
  for (const response of responses) assert.equal(response.status, 200);
  assert.equal(h.calls.length, 1);
  const [call] = h.calls;
  assert.equal(call.method, "POST");
  assert.equal(call.url.href, "https://graph.example.test/v25.0/test-instagram-account/messages");
  assert.equal(call.headers.get("authorization"), "Bearer test-instagram-access-token");
  assert.deepEqual(call.body.recipient, { comment_id: "comment-guide" });
  assert.deepEqual(call.body.message, {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        text: GUIDE_RULE.reply_text,
        buttons: [{ type: "web_url", url: GUIDE_RULE.link_url, title: GUIDE_RULE.link_button_label }],
      },
    },
  });
  const row = eventRow(h, "comment-guide");
  assert.equal(row.status, "sent");
  assert.equal(row.matched_keyword, "GUIDE");
  assert.equal(row.rule_label, "Free guide");
  assert.ok(row.sent_at);
});

test("public replies with several lines rotate per comment and skip blank lines", async (t) => {
  const h = await fixture(t);
  const cookie = await h.login();
  const lines = ["Sent it to you!", "Check your DMs.", "On its way."];
  await createRule(h, cookie, { ...GUIDE_RULE, public_reply_text: `${lines[0]}\n\n   \n${lines[1]}\r\n${lines[2]}` });
  for (let index = 0; index < 12; index += 1) {
    await h.webhook(commentPayload(`rotation-${index}`, "GUIDE"));
  }
  const replies = publicCalls(h).map((call) => call.url.searchParams.get("message"));
  assert.equal(replies.length, 12);
  assert.equal(privateCalls(h).length, 12);
  for (const reply of replies) assert.ok(lines.includes(reply), `Unexpected public reply: ${reply}`);
  assert.ok(new Set(replies).size > 1, "Different comments should receive different public replies");
  for (const call of publicCalls(h)) {
    assert.equal(call.headers.get("authorization"), "Bearer test-instagram-access-token");
  }
});

test("the KEYWORD fallback from wrangler.jsonc replies when no dashboard rule matches", async (t) => {
  const h = await fixture(t);
  const cookie = await h.login();
  // The migration's example rule uses "guide" but starts switched off.
  assert.equal(h.query("SELECT active FROM rules WHERE label = 'Example lead magnet'").active, 0);
  h.setResponder(() => new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 503 }));
  // The fallback uses the same strict matching as dashboard rules.
  await h.webhook(commentPayload("fallback-question", "Is there a guide for beginners?"));
  assert.equal(eventRow(h, "fallback-question").status, "ignored_no_keyword");
  await h.webhook(commentPayload("fallback-comment", "guide please?"));
  assert.deepEqual(privateCalls(h)[0].body.message, { text: "A fallback reply" });
  const failed = eventRow(h, "fallback-comment");
  assert.equal(failed.status, "send_error");
  assert.equal(failed.matched_rule_id, 0);
  assert.equal(failed.rule_label, "Fallback rule");
  h.setResponder(() => Response.json({ message_id: "retry-ok" }));
  const retried = await h.postForm("/admin/events/fallback-comment/retry", {}, cookie);
  assert.equal(retried.status, 303, await retried.text());
  assert.equal(eventRow(h, "fallback-comment").status, "sent");
  assert.equal(privateCalls(h).length, 2);
});

test("the account's own comments are ignored by username or by account ID", async (t) => {
  const h = await fixture(t);
  const cookie = await h.login();
  await createRule(h, cookie, GUIDE_RULE);
  await h.webhook(commentPayload("owner-by-name", "GUIDE", "test_owner"));
  const ownReply = commentPayload("owner-by-id", "Sent you the guide");
  ownReply.entry[0].changes[0].value.from = { id: h.env.IG_USER_ID };
  await h.webhook(ownReply);
  assert.equal(eventRow(h, "owner-by-name").status, "ignored_owner");
  assert.equal(eventRow(h, "owner-by-id").status, "ignored_owner");
  await h.webhook(commentPayload("no-keyword", "Love this post"));
  assert.equal(eventRow(h, "no-keyword").status, "ignored_no_keyword");
  assert.equal(h.calls.length, 0);
});

test("unsigned or incorrectly signed webhook data cannot trigger outgoing messages", async (t) => {
  const h = await fixture(t);
  const cookie = await h.login();
  await createRule(h, cookie, GUIDE_RULE);
  for (const signature of ["", "sha256=bad", `sha256=${"0".repeat(64)}`]) {
    const response = await h.webhook(commentPayload("invalid-signature"), signature);
    assert.equal(response.status, 401);
  }
  assert.equal(h.query("SELECT COUNT(*) AS count FROM comment_events").count, 0);
  assert.equal(h.calls.length, 0);
});

test("webhook verification echoes the challenge only for the configured token", async (t) => {
  const h = await fixture(t);
  const ok = await h.request("/webhook?hub.mode=subscribe&hub.verify_token=test-webhook-verify-token&hub.challenge=12345");
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "12345");
  const wrong = await h.request("/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345");
  assert.equal(wrong.status, 403);
});

test("test mode records matches without sending and blocks retries", async (t) => {
  const h = await fixture(t, { DRY_RUN: "true" });
  const cookie = await h.login();
  await createRule(h, cookie, { ...GUIDE_RULE, public_reply_text: "Sent it!" });
  await h.webhook(commentPayload("dry-comment", "GUIDE"));
  const row = eventRow(h, "dry-comment");
  assert.equal(row.status, "dry_run_matched");
  assert.equal(row.sent_at, null);
  await h.db.prepare(`INSERT INTO comment_events (comment_id, comment_text, matched, status, error, matched_rule_id, matched_keyword, rule_label, received_at)
    VALUES ('old-failure', 'GUIDE', 1, 'send_error', 'Earlier failure', ?, 'GUIDE', 'Free guide', ?)`)
    .bind(row.matched_rule_id, new Date().toISOString()).run();
  const retry = await h.postForm("/admin/events/old-failure/retry", {}, cookie);
  assert.equal(retry.status, 400);
  const html = await (await h.request("/admin", { headers: { cookie } })).text();
  assert.match(html, /Test match/);
  assert.doesNotMatch(html, /\/retry"/, "Retry buttons are hidden in test mode");
  assert.equal(h.calls.length, 0);
});

test("retrying a failed public reply resends only the public reply", async (t) => {
  const h = await fixture(t);
  const cookie = await h.login();
  await createRule(h, cookie, { ...GUIDE_RULE, public_reply_text: "Sent it to you!\nCheck your DMs." });
  let failPublic = true;
  h.setResponder((call) => {
    if (call.url.pathname.endsWith("/replies") && failPublic) {
      return new Response(JSON.stringify({ error: { message: "temporary public reply error" } }), { status: 500 });
    }
    return Response.json({ id: "test-success" });
  });
  await h.webhook(commentPayload("public-failure", "GUIDE"));
  const failed = eventRow(h, "public-failure");
  assert.equal(failed.status, "sent_public_reply_error");
  assert.equal(privateCalls(h).length, 1);
  assert.equal(publicCalls(h).length, 1);
  const html = await (await h.request("/admin", { headers: { cookie } })).text();
  assert.match(html, /Retry public reply/);
  failPublic = false;
  const retried = await h.postForm("/admin/events/public-failure/retry", {}, cookie);
  assert.equal(retried.status, 303, await retried.text());
  assert.equal(privateCalls(h).length, 1, "Only the failed public reply is retried");
  assert.equal(publicCalls(h).length, 2);
  const [first, second] = publicCalls(h).map((call) => call.url.searchParams.get("message"));
  assert.equal(second, first, "A retry keeps the reply chosen for this comment");
  const row = eventRow(h, "public-failure");
  assert.equal(row.status, "sent");
  assert.equal(row.sent_at, failed.sent_at, "The original DM delivery time is kept");
  assert.equal(JSON.parse(row.meta_response).privateReply.id, "test-success");
  const again = await h.postForm("/admin/events/public-failure/retry", {}, cookie);
  assert.ok(again.status >= 400 && again.status < 500);
  assert.equal(h.calls.length, 3);
});

test("a failed private reply can be retried once, and a paused rule blocks the retry", async (t) => {
  const h = await fixture(t);
  const cookie = await h.login();
  const rule = await createRule(h, cookie, GUIDE_RULE);
  h.setResponder(() => new Response(JSON.stringify({ error: "temporarily unavailable" }), { status: 503 }));
  await h.webhook(commentPayload("private-failure", "GUIDE"));
  assert.equal(eventRow(h, "private-failure").status, "send_error");
  assert.match(eventRow(h, "private-failure").error, /Meta API 503/);
  assert.equal(h.calls.length, 1);
  await h.postForm(`/admin/rules/${rule.id}`, { action: "toggle" }, cookie);
  const pausedRetry = await h.postForm("/admin/events/private-failure/retry", {}, cookie);
  assert.equal(pausedRetry.status, 400);
  assert.equal(h.calls.length, 1);
  await h.postForm(`/admin/rules/${rule.id}`, { action: "toggle" }, cookie);
  h.setResponder(() => Response.json({ message_id: "retry-success" }));
  const retries = await Promise.all([
    h.postForm("/admin/events/private-failure/retry", {}, cookie),
    h.postForm("/admin/events/private-failure/retry", {}, cookie),
  ]);
  assert.equal(retries.filter((response) => response.status === 303).length, 1);
  assert.equal(retries.filter((response) => response.status >= 400 && response.status < 500).length, 1);
  assert.equal(h.calls.length, 2);
  assert.equal(eventRow(h, "private-failure").status, "sent");
});

test("editing a rule's keyword prevents retrying an older comment against the changed rule", async (t) => {
  const h = await fixture(t);
  const cookie = await h.login();
  const fields = { label: "Encouragement", keywords: "CHEER", reply_text: "Thanks for being here!" };
  const rule = await createRule(h, cookie, fields);
  h.setResponder(() => new Response(JSON.stringify({ error: "temporary failure" }), { status: 503 }));
  await h.webhook(commentPayload("edited-rule-comment", "CHEER"));
  assert.equal(eventRow(h, "edited-rule-comment").status, "send_error");
  const updated = await h.postForm(`/admin/rules/${rule.id}`, { ...fields, keywords: "JOY", active: "on" }, cookie);
  assert.equal(updated.status, 303);
  const retry = await h.postForm("/admin/events/edited-rule-comment/retry", {}, cookie);
  assert.equal(retry.status, 400);
  assert.equal(h.calls.length, 1, "A changed rule must not be sent to a previously matched comment");
});

test("rule validation enforces Instagram message limits and complete link buttons", async (t) => {
  const h = await fixture(t);
  const cookie = await h.login();
  const count = () => h.query("SELECT COUNT(*) AS count FROM rules").count;
  const before = count();
  const invalid = [
    { keywords: "" },
    { reply_text: "" },
    { link_button_label: "" },
    { link_url: "" },
    { link_url: "http://example.com/guide" },
    { link_url: "javascript:alert(1)" },
    { link_button_label: "x".repeat(21) },
    { reply_text: "x".repeat(641) },
    { link_url: "", link_button_label: "", reply_text: "x".repeat(1001) },
    { public_reply_text: "x".repeat(2201) },
    { channels: "everywhere" },
    { keywords: "@yourhandle" },
  ];
  for (const fields of invalid) {
    const response = await h.postForm("/admin/rules", { ...GUIDE_RULE, label: "Invalid", active: "on", ...fields }, cookie);
    assert.equal(response.status, 400, JSON.stringify(fields).slice(0, 120));
  }
  assert.equal(count(), before);
  await createRule(h, cookie, { ...GUIDE_RULE, reply_text: "x".repeat(640) });
  await createRule(h, cookie, { ...GUIDE_RULE, label: "Plain text", keywords: "PLAIN", link_url: "", link_button_label: "", reply_text: "y".repeat(1000) });
  assert.equal(count(), before + 2);
  assert.equal(h.calls.length, 0);
});

test("admin routes require a session and reject cross-site writes", async (t) => {
  const h = await fixture(t);
  const login = await h.request("/admin");
  assert.equal(login.status, 200);
  assert.match(await login.text(), /<h1>Sign in<\/h1>[\s\S]*name="token"/);
  const wrongPassword = await h.postForm("/admin/login", { token: "wrong" });
  assert.equal(wrongPassword.headers.get("location"), "/admin?error=1");
  const before = h.query("SELECT COUNT(*) AS count FROM rules").count;
  for (const path of ["/admin/rules", "/admin/rules/1", "/admin/events/missing/retry"]) {
    const response = await h.postForm(path, { ...GUIDE_RULE, active: "on" });
    assert.equal(response.status, 303, path);
    assert.equal(response.headers.get("location"), "/admin", path);
  }
  const cookie = await h.login();
  for (const headers of [{ origin: "https://untrusted.example.test" }, { "sec-fetch-site": "cross-site" }]) {
    const response = await h.request("/admin/rules", {
      method: "POST",
      headers: { cookie, ...headers },
      body: new URLSearchParams({ ...GUIDE_RULE, active: "on" }),
    });
    assert.equal(response.status, 403);
  }
  assert.equal(h.query("SELECT COUNT(*) AS count FROM rules").count, before);
  const malformed = await h.request("/admin/events/%E0%A4%A/retry", { method: "POST", headers: { cookie } });
  assert.equal(malformed.status, 400, "A malformed comment ID is rejected, not a server error");
  const dashboard = await h.request("/admin", { headers: { cookie } });
  assert.equal(dashboard.headers.get("cache-control"), "no-store");
  assert.equal(h.calls.length, 0);
});

test("the dashboard escapes rule copy, comments and usernames", async (t) => {
  const h = await fixture(t, { DRY_RUN: "true" });
  const cookie = await h.login();
  const hostileLabel = '</textarea><script>window.__injected=true</script>';
  const hostileReply = '<img src=x onerror=alert(1)> & hello';
  const hostileComment = 'GUIDE <img src=x onerror=alert(2)>';
  const hostileUsername = '"><script>alert(3)</script>';
  await createRule(h, cookie, { ...GUIDE_RULE, label: hostileLabel, reply_text: hostileReply, public_reply_text: hostileReply });
  await h.webhook(commentPayload("unsafe-comment", hostileComment, hostileUsername));
  const response = await h.request("/admin", { headers: { cookie } });
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const hostile of [hostileLabel, hostileReply, hostileComment, hostileUsername]) {
    assert.equal(html.includes(hostile), false, "Untrusted content must not appear as raw markup");
  }
  assert.ok(html.includes("&lt;/textarea&gt;&lt;script&gt;window.__injected=true&lt;/script&gt;"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt; &amp; hello"));
  assert.ok(html.includes("GUIDE &lt;img src=x onerror=alert(2)&gt;"));
  assert.ok(html.includes("&quot;&gt;&lt;script&gt;alert(3)&lt;/script&gt;"));
  assert.equal(h.calls.length, 0);
});
