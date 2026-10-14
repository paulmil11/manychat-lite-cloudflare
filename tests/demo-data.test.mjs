import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { buildWorker, createHarness } from "./worker-harness.mjs";

// scripts/demo-data.sql must keep working with the migrations, the dashboard
// and the placeholder values in .dev.vars.example that the README tells people to use.
let built;
before(async () => { built = await buildWorker(); });
after(async () => { await built?.dispose(); });

async function exampleVars() {
  const text = await readFile(".dev.vars.example", "utf8");
  return Object.fromEntries(text.split("\n")
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]));
}

test("the local demo data loads after the migrations and fills every dashboard section", async (t) => {
  const vars = await exampleVars();
  assert.equal(vars.DRY_RUN, "true", ".dev.vars.example keeps test mode on");
  const h = await createHarness(built.worker, { ...vars, GRAPH_API_BASE: "https://graph.instagram.com/v25.0" });
  t.after(() => h.dispose());
  const sql = await readFile("scripts/demo-data.sql", "utf8");
  await h.db.exec(sql);
  await h.db.exec(sql);
  assert.equal(h.query("SELECT COUNT(*) AS count FROM rules WHERE id BETWEEN 101 AND 105").count, 5, "Re-running replaces the demo rows");
  assert.equal(h.query("SELECT COUNT(*) AS count FROM comment_events").count, 11);
  assert.equal(h.query("SELECT COUNT(*) AS count FROM message_events").count, 9);
  assert.deepEqual(JSON.parse(h.query("SELECT channels FROM rules WHERE id = 105").channels), ["dms", "stories"]);
  assert.equal(h.query("SELECT COUNT(*) AS count FROM instagram_tokens").count, 1);

  const cookie = await h.login();
  const json = await (await h.request("/admin/dm-features", { headers: { cookie } })).json();
  assert.equal(json.settings.startersEnabled, true, "Demo DM settings must pass validation");
  assert.equal(json.settings.starters.length, 4);
  assert.equal(json.settings.storyRules.length, 3);
  assert.equal(json.settings.customReplies.length, 2);

  const connection = await (await h.request("/admin/connection", { headers: { cookie } })).json();
  assert.equal(connection.state, "healthy", "The demo connection record must match the .dev.vars.example placeholders");
  assert.equal(connection.username, "demo.creator");
  assert.ok(connection.nextRefreshAt && connection.expiresAt && connection.lastRefreshedAt);

  const html = await (await h.request("/admin", { headers: { cookie } })).text();
  for (const expected of [
    "Free photo guide", "Lightroom presets", "Workshop waitlist", "Podcast episode", "Photo walk sign-up",
    "<span>DMs, Story replies</span>", "@demo_reader_1", "@demo_reader_10", "Conversation starter", "Story reply",
    "Link source: newsletter", "Custom replies", "Collaborations", "Any story reply with GUIDE", "Not on Instagram yet",
    "https://ig.me/demo.creator?ref=rule-101__website", "@demo.creator", "Instagram connection",
  ]) {
    assert.ok(html.includes(expected), `Dashboard should show ${expected}`);
  }
  const recent = html.match(/<div class="recent-dms">([\s\S]*?)<\/div>\s*<\/section>/)?.[1] ?? "";
  assert.equal((recent.match(/<article class="dm-row"/g) ?? []).length, 5, "Recent DMs shows the latest five");
  assert.match(recent, /replied to your story/);

  // Comments that only mention a keyword in passing are not matches under the strict rule.
  for (const id of ["demo-c9", "demo-c10"]) {
    const row = h.query("SELECT comment_text, status FROM comment_events WHERE comment_id = ?", id);
    assert.equal(row.status, "ignored_no_keyword", row.comment_text);
  }

  const sent = await (await h.request("/admin/sent", { headers: { cookie } })).text();
  assert.match(sent, /replied to your story/);
  assert.match(sent, /opened your DM link from newsletter/);
  assert.match(sent, /inside “guidelines”/, "The older partial-word send is flagged");
  assert.match(sent, /data-kind="dm" data-failed="1"/, "The failed DM is listed");
  assert.match(sent, /<mark>WALK<\/mark>/, "A story reply answered by an automation highlights its keyword");
  assert.doesNotMatch(sent, /demo_reader_14|demo_reader_15|demo_reader_19/, "Unmatched comments and DMs are not sent DMs");
  const connectionPanel = html.match(/<section id="connection"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.equal((connectionPanel.match(/<time /g) ?? []).length, 4, "Every connection date is filled");
  assert.equal(h.calls.length, 0, "Loading demo data never calls Instagram");
});
