import { customReplyKey, ruleReplyKey, type DmFeatureSettings, type IceBreakersPublicationStatus } from "./dm-features";
import {
  dmFeaturesClientScript,
  dmFeaturesStyles,
  renderDmFeaturesPanel,
  renderDmMessageContext,
  type ReplyOption
} from "./dm-features-panel";
import type { InstagramTokenStatus } from "./instagram-token";
import { keywordMatch } from "./keyword-match";
import { renderSentRows, sentRowStyles, type SentDmRow } from "./sent-dms";
import { baseStyles, formStyles, headerStyles, PRODUCT_NAME, renderHeader } from "./theme";
import type {
  ActivityFilters,
  Channel,
  DashboardStats,
  RecentEventRow,
  RecentMessageRow,
  ReplyStatsRow,
  Rule
} from "./types";

export type DashboardData = {
  dryRun: boolean;
  localPreview: boolean;
  rules: Rule[];
  recentEvents: RecentEventRow[];
  messageEvents: RecentMessageRow[];
  // The latest outgoing DMs, from the Sent DMs query.
  recentDms: SentDmRow[];
  replyStats: ReplyStatsRow[];
  stats: DashboardStats;
  connection: InstagramTokenStatus;
  dmFeatures: DmFeatureSettings;
  publication: IceBreakersPublicationStatus;
  // The connected Instagram username (or OWNER_IG_USERNAME), without "@".
  accountUsername: string | null;
  filters: ActivityFilters;
  flash: string | null;
};

const icons: Record<string, string> = {
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'
};

function icon(name: string, cls = ""): string {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? icons.arrow}</svg>`;
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function number(value: number): string {
  return Number(value ?? 0).toLocaleString("en-US");
}

function plural(value: number, singular: string, pluralForm: string): string {
  return `${number(value)} ${value === 1 ? singular : pluralForm}`;
}

function tag(text: string, tone = ""): string {
  return `<span class="tag ${tone}">${esc(text)}</span>`;
}

function time(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? esc(value)
    : `<time datetime="${esc(date.toISOString())}" title="${esc(date.toISOString())}">${esc(date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }))} UTC</time>`;
}

function figure(label: string, value: number, detail: string, tone = ""): string {
  return `<div class="figure ${tone}"><dt>${esc(label)}</dt><dd class="figure-value">${number(value)}</dd><dd class="figure-detail">${esc(detail)}</dd></div>`;
}

const CHANNEL_OPTIONS: Array<[Channel, string, string]> = [
  ["comments", "Comments", "On any of your posts"],
  ["dms", "DMs", "When someone messages you"],
  ["stories", "Story replies", "When someone replies to a story"]
];

function channelSummary(channels: Channel[]): string {
  return CHANNEL_OPTIONS.filter(([value]) => channels.includes(value)).map(([, title]) => title).join(", ");
}

// The hidden empty value tells the server the picker was on the page, so
// unchecking every box is an error instead of "use the default".
function channelPicker(selected: Channel[]): string {
  return `<fieldset class="channel-picker"><legend>Listen for it in</legend><input type="hidden" name="channels" value=""><div class="channels">${CHANNEL_OPTIONS.map(([value, title, hint]) => `<label class="channel"><input type="checkbox" name="channels" value="${value}" ${selected.includes(value) ? "checked" : ""}><span><strong>${title}</strong><small>${hint}</small></span></label>`).join("")}</div></fieldset>`;
}

export function renderDashboardPage(data: DashboardData): string {
  const active = data.rules.filter((rule) => rule.active).length;
  const handle = data.accountUsername ? `@${data.accountUsername}` : "";
  const mode = `<span class="mode ${data.dryRun ? "test" : ""}"><i></i>${data.dryRun ? "Test mode" : "Live"}</span>`;
  const replyOptions: ReplyOption[] = [
    ...data.rules.map((rule) => ({
      key: ruleReplyKey(rule.id),
      label: rule.label,
      group: "rule" as const,
      detail: rule.active ? "" : "paused"
    })),
    ...data.dmFeatures.customReplies.map((reply) => ({
      key: customReplyKey(reply.id),
      label: reply.label,
      group: "text" as const,
      detail: ""
    }))
  ];
  const firstRule = data.rules.find((rule) => rule.active) ?? data.rules[0];
  const notices = [
    data.flash ? `<div class="flash" role="status">${esc(data.flash)}</div>` : "",
    data.localPreview ? '<div class="notice"><strong>Local preview.</strong> Counts and settings come from the local development database, not from Instagram.</div>' : "",
    data.dryRun ? '<div class="notice">Test mode is on. Matches are logged, but nothing is sent.</div>' : "",
    data.connection.needsReconnect || data.connection.state === "error"
      ? `<div class="notice" role="alert"><strong>Instagram needs attention.</strong> ${esc(data.connection.error ?? "Check your connection.")} <a href="#connection">View connection</a></div>`
      : ""
  ].filter(Boolean).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${PRODUCT_NAME} for Instagram</title><style>${baseStyles}${formStyles}${headerStyles}${styles}${sentRowStyles}${dmFeaturesStyles}</style></head><body>
  <a class="skip" href="#main">Skip to content</a>
  ${renderHeader("overview", mode)}
  <main id="main" class="shell">
    ${notices ? `<div class="notices">${notices}</div>` : ""}
    <section id="overview" class="overview" aria-labelledby="overview-title">
      <div class="page-head"><h1 id="overview-title">Overview</h1>${handle ? `<span>${esc(handle)}</span>` : ""}</div>
      <dl class="figures" aria-label="${data.localPreview ? "Local test data" : "All-time totals"}">
        ${figure("DMs sent", data.stats.sent, data.dryRun ? plural(data.stats.testMatches, "test match", "test matches") : "All time · comments + DMs")}
        ${figure("Received", data.stats.comments + data.stats.messages, `${plural(data.stats.comments, "comment", "comments")} · ${plural(data.stats.messages, "DM", "DMs")}`)}
        ${figure("Errors", data.stats.errors, data.stats.errors ? "Failed DMs or public replies" : "None recorded", data.stats.errors ? "danger" : "")}
        ${figure("Automations on", active, `of ${number(data.rules.length)}`)}
      </dl>
    </section>
    <section class="block" aria-labelledby="recent-title">
      <div class="block-head"><h2 id="recent-title">Recent DMs</h2><a class="link" href="/admin/sent">All sent DMs ${icon("arrow")}</a></div>
      ${data.recentDms.length ? `<div class="recent-dms">${renderSentRows(data.recentDms)}</div>` : `<p class="empty">${data.dryRun ? "No DMs sent yet. Test mode is on, so matches only show up under Activity." : "No DMs sent yet."}</p>`}
    </section>
    <section id="automations" class="block" aria-labelledby="automations-title">
      <div class="block-head"><div><h2 id="automations-title">Automations</h2><p class="block-sub">A keyword in a comment, DM, or story reply sends a DM back.</p></div><button class="button secondary" type="button" data-new-rule>${icon("plus")}New automation</button></div>
      <div class="automations-layout">
        <div class="auto-list">${data.rules.map((rule) => ruleRow(rule, data.replyStats.find((row) => row.key === ruleReplyKey(rule.id)))).join("")}
        ${data.rules.length ? "" : '<div class="empty">No automations yet. <button class="text-link" type="button" data-new-rule>Create the first one</button></div>'}</div>
        ${previewPanel(firstRule)}
      </div>
    </section>
    <section id="performance" class="block performance" aria-labelledby="performance-title"><div class="block-head"><div><h2 id="performance-title">Reply stats</h2><p class="block-sub">${data.localPreview ? "Local test data." : "All time, per automation and custom reply."}</p></div></div>${analytics(data.replyStats, data.rules)}</section>
    <section id="activity" class="block activity" aria-labelledby="activity-title"><div class="block-head"><div><h2 id="activity-title">Activity</h2><p class="block-sub">Everything that came in, including comments and DMs that didn’t match.</p></div><span class="activity-links"><a class="link" href="/admin/sent">Sent DMs only</a><a class="link quiet" href="/admin#activity">Refresh</a></span></div>
      <div class="activity-tabs" role="tablist" aria-label="Activity type"><button id="comments-tab" type="button" role="tab" aria-selected="true" aria-controls="comment-activity" data-tab="comment-activity">Comments <span>${data.recentEvents.length}</span></button><button id="messages-tab" type="button" role="tab" aria-selected="false" aria-controls="message-activity" data-tab="message-activity" tabindex="-1">Direct messages <span>${data.messageEvents.length}</span></button></div>
      <div id="comment-activity" role="tabpanel" aria-labelledby="comments-tab">${filters(data.filters)}${comments(data.recentEvents, data.dryRun)}</div>
      <div id="message-activity" role="tabpanel" aria-labelledby="messages-tab" hidden><p class="field-help list-note">Latest 30 incoming DMs, conversation starter taps, story replies and DM link opens. Filters apply to comments only.</p>${messages(data.messageEvents)}</div>
    </section>
    <div id="settings" class="settings">
      <div class="block-head"><div><h2>Settings</h2><p class="block-sub">DM tools, custom replies and your Instagram connection.</p></div></div>
      ${renderDmFeaturesPanel({
        settings: data.dmFeatures,
        publication: data.publication,
        options: replyOptions,
        username: data.accountUsername,
        dryRun: data.dryRun
      })}
      ${connectionPanel(data.connection, data.dryRun)}
    </div>
  </main>
  <footer class="site-footer"><span>${PRODUCT_NAME} for Instagram</span><a href="https://developers.facebook.com/apps/" target="_blank" rel="noopener noreferrer">Meta app settings ${icon("external")}</a></footer>
  ${newRuleDialog(data.rules, data.accountUsername)}<script>${clientScript}${newRuleScript}${dmFeaturesClientScript}</script></body></html>`;
}

function connectionPanel(connection: InstagramTokenStatus, dryRun: boolean): string {
  const label = dryRun ? "Test mode" : connection.state === "healthy" ? "Connected" : connection.needsReconnect ? "Reconnect required" : connection.state === "error" ? "Check failed" : "Not checked yet";
  return `<section id="connection" class="setting connection-panel" aria-labelledby="connection-title">
    <div class="setting-intro"><h3 id="connection-title">Instagram connection</h3><p>${dryRun ? "Connection checks and token renewal are off in test mode." : "Checked daily. The token renews itself before it expires."}</p>${tag(label, !dryRun && connection.state === "healthy" ? "ok" : "warn")}</div>
    <div class="setting-body">
      ${connection.username ? `<p class="connection-handle">@${esc(connection.username)}</p>` : ""}
      ${connection.error ? `<p class="notice" role="status">${esc(connection.error)}</p>` : ""}
      <dl class="connection-dates"><div><dt>Last checked</dt><dd>${connection.lastCheckedAt ? time(connection.lastCheckedAt) : "Not yet"}</dd></div><div><dt>Last renewed</dt><dd>${connection.lastRefreshedAt ? time(connection.lastRefreshedAt) : "Not yet"}</dd></div><div><dt>Next renewal</dt><dd>${connection.nextRefreshAt ? time(connection.nextRefreshAt) : "After the first check"}</dd></div><div><dt>Token expires</dt><dd>${connection.expiresAt ? time(connection.expiresAt) : "Known after the first renewal"}</dd></div></dl>
      <div class="form-actions"><a class="text-link" href="https://developers.facebook.com/apps/" target="_blank" rel="noopener noreferrer">Open Meta settings ${icon("external")}</a><form action="/admin/connection/check" method="post"><button class="button secondary" ${dryRun ? "disabled" : ""}>Check connection</button></form></div>
    </div>
  </section>`;
}

function previewHref(url: string | null): string {
  try {
    if (url && new URL(url).protocol === "https:") return `href="${esc(url)}" target="_blank" rel="noopener noreferrer"`;
  } catch { /* An invalid link is shown without a target. */ }
  return "";
}

type ReplyPreview = {
  title: string; keyword: string; text: string; source: string; active: boolean; comments: boolean;
  publicReply: string; buttons: Array<{ title: string; url: string }>;
};

function rulePreview(rule: Rule): ReplyPreview {
  return {
    title: rule.label,
    keyword: rule.keywords[0]?.toUpperCase() ?? "",
    text: rule.replyText,
    source: `${channelSummary(rule.channels)} → DM`,
    active: rule.active,
    comments: rule.channels.includes("comments"),
    publicReply: rule.publicReplyText ?? "",
    buttons: rule.linkUrl && rule.linkButtonLabel ? [{ title: rule.linkButtonLabel, url: rule.linkUrl }] : []
  };
}

function autoSummary(rule: Rule, sent: number): string {
  return `<span class="auto-name"><strong>${esc(rule.label)}</strong><span>${esc(channelSummary(rule.channels))}</span></span><span class="auto-keys">${rule.keywords.map((key) => esc(key.toUpperCase())).join('<span class="sep">, </span>')}</span><span class="auto-sent">${number(sent)} sent</span><span class="auto-state ${rule.active ? "on" : ""}">${rule.active ? "On" : "Paused"}</span>${icon("chevron", "chevron")}`;
}

function ruleRow(rule: Rule, stats?: ReplyStatsRow): string {
  return `<details class="auto rule-card ${rule.active ? "" : "paused"}" data-preview="${esc(JSON.stringify(rulePreview(rule)))}"><summary>${autoSummary(rule, stats?.sent ?? 0)}</summary>
    <form action="/admin/rules/${rule.id}" method="post" class="auto-edit"><div class="two-fields"><label>Name<input name="label" value="${esc(rule.label)}" required maxlength="100"></label><label>Keywords<input name="keywords" value="${esc(rule.keywords.join(", "))}" required></label></div>${channelPicker(rule.channels)}
    <label>DM message<textarea name="reply_text" rows="3" required>${esc(rule.replyText)}</textarea><span class="field-help">Up to 1,000 characters, or 640 with a button.</span></label><label>Public comment reply <span class="optional">optional · one variation per line · comments only</span><textarea name="public_reply_text" rows="2">${esc(rule.publicReplyText ?? "")}</textarea></label><div class="two-fields"><label>Button link<input name="link_url" type="url" value="${esc(rule.linkUrl ?? "")}" placeholder="https://…"></label><label>Button label<input name="link_button_label" value="${esc(rule.linkButtonLabel ?? "")}" maxlength="20" placeholder="Read more"></label></div><div class="form-actions"><label class="switch-label"><input type="checkbox" name="active" ${rule.active ? "checked" : ""}><span class="switch"></span>On</label><div><button class="button danger" name="action" value="delete" formnovalidate data-delete>Delete</button><button class="button primary" name="action" value="save">Save changes</button></div></div></form></details>`;
}

// Chat-style preview of the selected automation. The client script updates it as you edit.
function previewPanel(rule: Rule | undefined): string {
  const preview = rule ? rulePreview(rule) : null;
  const publicReplies = preview?.comments ? preview.publicReply.split("\n").map((line) => line.trim()).filter(Boolean) : [];
  return `<aside class="preview-panel" id="reply-preview" aria-label="Reply preview"><div class="preview-heading"><span id="preview-heading">${esc(preview?.title ?? "Reply preview")}</span><span class="preview-tag">Preview</span></div>
    <div class="chat"><div class="chat-date" id="preview-source">${esc(preview?.source ?? "Comment → DM")}</div><div class="incoming"><span id="preview-keyword">${esc(preview?.keyword || "KEYWORD")}</span></div>
      <div class="chat-reply"><div id="preview-message" class="bubble">${esc(preview?.text ?? "Your message appears here.")}</div><div class="chat-buttons" id="preview-buttons">${(preview?.buttons ?? []).map((button) => `<a ${previewHref(button.url)}>${esc(button.title)} ↗</a>`).join("")}</div></div>
      <div class="public-preview" id="preview-public" ${publicReplies.length ? "" : "hidden"}><span id="preview-public-label">${publicReplies.length > 1 ? `Public reply · 1 of ${publicReplies.length}` : "Public reply"}</span><p id="preview-public-text">${esc(publicReplies[0] ?? "")}</p></div></div>
    <p class="preview-note" id="preview-note">${preview ? (preview.active ? "Updates as you edit. Nothing is sent." : "Paused. This automation won’t send replies.") : "Create an automation to preview its reply."}</p></aside>`;
}

function analytics(rows: ReplyStatsRow[], rules: Rule[]): string {
  if (!rows.length) return '<p class="empty">No automations yet.</p>';
  const source = (row: ReplyStatsRow): string => {
    if (row.kind === "text") return "Custom reply · DMs";
    if (row.kind === "fallback") return "KEYWORD fallback · comments";
    const rule = rules.find((item) => ruleReplyKey(item.id) === row.key);
    return `Keyword · ${rule ? channelSummary(rule.channels) : "Comments"}`;
  };
  return `<div class="table-scroll"><table><thead><tr><th>Automation</th><th>Comment matches</th><th>DM matches</th><th>DMs sent</th><th>Errors</th><th>Last sent</th></tr></thead><tbody>${rows.map((row) => `<tr><td><strong>${esc(row.label)}</strong><div class="table-sub">${esc(source(row))}</div></td><td>${row.kind === "text" ? '<span class="muted">—</span>' : number(row.commentMatches)}</td><td>${row.kind === "fallback" ? '<span class="muted">—</span>' : number(row.dmMatches)}</td><td><span class="sent-value">${number(row.sent)}</span></td><td>${row.errors ? `<span class="error-value">${number(row.errors)}</span>` : '<span class="muted">0</span>'}</td><td class="muted">${row.lastSentAt ? time(row.lastSentAt) : "Not sent yet"}</td></tr>`).join("")}</tbody></table></div><p class="field-help table-foot">Matches include test-mode matches and DMs from starters, story rules and links. DMs sent counts delivered messages only.</p>`;
}

function filters(value: ActivityFilters): string {
  const options = [["", "All statuses"], ["sent", "Sent"], ["error", "Errors"], ["dry_run_matched", "Test matches"], ["ignored_no_keyword", "No keyword"], ["ignored_owner", "Your comments"]];
  return `<form class="filters" action="/admin#activity" method="get"><label>Status<select name="status">${options.map(([key, name]) => `<option value="${key}" ${value.status === key ? "selected" : ""}>${name}</option>`).join("")}</select></label><label>Keyword<input name="keyword" value="${esc(value.keyword)}" placeholder="Any keyword"></label><label>Username<input name="username" value="${esc(value.username)}" placeholder="@reader"></label><label>Date (UTC)<input name="date" type="date" value="${esc(value.date)}"></label><button class="button secondary">Apply</button><a href="/admin#activity" class="text-link">Clear</a></form>`;
}

const STATUS_NAMES: Record<string, string> = {
  sent: "Sent", sent_public_reply_error: "Public reply failed", send_error: "Send failed", dry_run_matched: "Test match",
  ignored_no_keyword: "No keyword", ignored_no_match: "No match", ignored_owner: "Your comment", ignored_self: "Your message",
  ignored_paused: "Paused", ignored_expired: "Reply window closed", ignored_recipient: "Another account",
  ignored_invalid: "Invalid timestamp", ignored_missing_reply: "Reply removed", received: "Received", retrying: "Retrying"
};

function status(value: string): string {
  const tone = value === "sent" ? "ok" : value.includes("error") ? "danger" : value === "dry_run_matched" ? "warn" : "";
  return `<span class="status ${tone}">${esc(STATUS_NAMES[value] ?? value.replace(/_/g, " "))}</span>`;
}

function comments(rows: RecentEventRow[], dryRun: boolean): string {
  if (!rows.length) return '<p class="empty">No matching comments. Comments appear here once Instagram sends them; clear the filters to see everything.</p>';
  return `<div class="events">${rows.map((row) => `<article class="event"><div class="event-body"><div class="event-title"><strong>${esc(row.username ? "@" + row.username : "Unknown user")}</strong>${time(row.received_at)}</div><p>${esc(row.comment_text)}</p><span class="event-rule">${esc(row.rule_label ?? "No automation")}${row.matched_keyword ? ` <span>· ${esc(row.matched_keyword.toUpperCase())}</span>` : ""}</span>${row.error ? `<details class="error-details"><summary>View error</summary><p>${esc(row.error)}</p></details>` : ""}</div><div class="event-state">${status(row.status)}${!dryRun && (row.status === "send_error" || row.status === "sent_public_reply_error") ? `<form action="/admin/events/${encodeURIComponent(row.comment_id)}/retry" method="post"><button class="text-link">${row.status === "sent_public_reply_error" ? "Retry public reply" : "Retry send"}</button></form>` : ""}</div></article>`).join("")}</div><p class="field-help list-foot">Latest ${rows.length} matching comments (up to 50).</p>`;
}

function messages(rows: RecentMessageRow[]): string {
  if (!rows.length) return '<p class="empty">No DMs yet. Subscribe to the messages, messaging_postbacks and messaging_referral webhooks to receive them.</p>';
  return `<div class="events">${rows.map((row) => `<article class="event"><div class="event-body"><div class="event-title"><strong>${row.sender_username ? `@${esc(row.sender_username.replace(/^@/, ""))}` : `Instagram user …${esc(row.sender_id.slice(-4))}`}</strong>${time(row.received_at)}</div>${row.message_text ? `<p>${esc(row.message_text)}</p>` : ""}<span class="event-rule">${esc(row.matched_choice ?? "No automation")}</span>${renderDmMessageContext(row)}${row.error ? `<details class="error-details"><summary>View error</summary><p>${esc(row.error)}</p></details>` : ""}</div><div class="event-state">${status(row.status)}</div></article>`).join("")}</div>`;
}

const RULE_TEMPLATES = [
  { label: "Book or product", name: "Product link", keyword: "LINK", message: "Here you go. Thanks for asking!", button: "Open link" },
  { label: "Free guide", name: "Free guide", keyword: "GUIDE", message: "Here’s the free guide. Hope it helps!", button: "Get the guide" },
  { label: "Event or workshop", name: "Event sign-up", keyword: "JOIN", message: "Here are the details and the sign-up link.", button: "Save my spot" },
  { label: "Waitlist", name: "Waitlist", keyword: "WAITLIST", message: "You’re one tap away from the waitlist.", button: "Join the waitlist" },
  { label: "Podcast episode", name: "Podcast episode", keyword: "EPISODE", message: "Here’s the full episode.", button: "Listen now" }
];
const SUGGESTED_PUBLIC_REPLIES = ["Sent you the link", "Check your DMs", "Just sent it over", "Dropped it in your DMs", "On it, check your DMs"];

function newRuleDialog(rules: Rule[], username: string | null): string {
  // Keywords of automations that are on, per channel. Paused automations may share a keyword.
  const taken: Record<string, Array<{ label: string; channels: Channel[] }>> = {};
  for (const rule of rules.filter((item) => item.active)) {
    for (const keyword of rule.keywords) (taken[keyword.trim().toLowerCase()] ??= []).push({ label: rule.label, channels: rule.channels });
  }
  const you = username?.replace(/^@/, "") || "yourhandle";
  return `<dialog id="new-rule" class="new-rule" aria-labelledby="new-rule-title" data-taken="${esc(JSON.stringify(taken))}" data-suggested="${esc(JSON.stringify(SUGGESTED_PUBLIC_REPLIES))}">
  <form method="post" action="/admin/rules" class="new-rule-form">
    <div class="dialog-heading"><div><h2 id="new-rule-title">New automation</h2><p class="dialog-sub">Pick a keyword and where to listen for it. When someone sends it, they get a DM from you.</p></div><button class="close-dialog" aria-label="Close" type="button">×</button></div>
    <div class="templates" role="group" aria-label="Start from"><span class="templates-label">Start from</span>${RULE_TEMPLATES.map((template) => `<button type="button" class="template" aria-pressed="false" data-template="${esc(JSON.stringify(template))}">${esc(template.label)}</button>`).join("")}<button type="button" class="template" aria-pressed="true" data-template="{}">Blank</button></div>
    <div class="new-rule-grid">
      <div class="new-rule-fields">
        <fieldset class="step"><legend>Trigger</legend>
          <label>Keyword<input name="keywords" id="nr-keywords" placeholder="GUIDE" required autocomplete="off" autocapitalize="characters"><span class="field-help">Add more than one with commas. Case doesn’t matter.</span></label>
          ${channelPicker(["comments"])}
          <p class="field-error" id="nr-keyword-error" role="alert" hidden></p>
          <div class="tester"><label>Try a message<input id="nr-test" placeholder="guide please" autocomplete="off"></label><p class="tester-result" id="nr-test-result" aria-live="polite">Add a keyword, then type a message to see if it would send.</p></div>
          <p class="field-help">Only short messages that are basically the keyword send a DM. “GUIDE please” works. “I loved your guide last week” doesn’t.</p>
        </fieldset>
        <fieldset class="step"><legend>The DM they get</legend>
          <label>Message<textarea name="reply_text" id="nr-message" rows="4" required placeholder="Here’s the link…"></textarea><span class="field-help counter" id="nr-message-count">0 / 1,000</span></label>
          <div class="two-fields"><label>Button text <span class="optional">optional</span><input name="link_button_label" id="nr-button" maxlength="20" placeholder="Open link"></label><label>Button link<input name="link_url" id="nr-link" type="url" inputmode="url" placeholder="https://…"></label></div>
          <p class="field-error" id="nr-button-error" role="alert" hidden></p>
        </fieldset>
        <fieldset class="step" id="nr-public-step"><legend>Public reply <span class="optional">optional, comments only</span></legend>
          <label class="sr-only" for="nr-public">Public reply</label><textarea name="public_reply_text" id="nr-public" rows="3" placeholder="One reply per line"></textarea>
          <div class="step-help"><span class="field-help">Posted under their comment. With several lines, each comment gets one of them.</span><button type="button" class="text-link" id="nr-suggest">Use suggested replies</button></div>
        </fieldset>
        <fieldset class="step"><legend>Name</legend>
          <label class="sr-only" for="nr-name">Name</label><input name="label" id="nr-name" maxlength="100" required placeholder="Shown in your dashboard">
        </fieldset>
      </div>
      <aside class="new-rule-preview" aria-label="Preview">
        <p class="preview-label">Preview</p>
        <div id="nrp-as-comment"><div class="ig-comment"><span class="ig-avatar" aria-hidden="true"></span><p><strong>reader</strong> <span id="nrp-comment">KEYWORD</span></p></div>
        <div class="ig-comment ig-reply" id="nrp-public-wrap" hidden><span class="ig-avatar you" aria-hidden="true"></span><p><strong>${esc(you)}</strong> <span id="nrp-public"></span></p></div>
        <p class="preview-divider">Then in their DMs</p></div>
        <div id="nrp-as-dm" hidden><p class="preview-divider" id="nrp-dm-caption">In your DMs</p><div class="incoming" id="nrp-dm-text">KEYWORD</div></div>
        <div class="chat-reply"><div class="bubble" id="nrp-message">Your message appears here.</div><div class="chat-buttons"><a id="nrp-button" hidden></a></div></div>
        <p class="preview-status" id="nrp-status"></p>
      </aside>
    </div>
    <p class="dialog-more">Buttons people see in new chats, story-specific rules, and links that open a reply live in <a href="#settings" data-close-dialog>Settings</a>.</p>
    <div class="dialog-footer"><label class="switch-label"><input name="active" type="checkbox" checked><span class="switch"></span>Turn on now</label><div><button type="button" class="button secondary" data-close-dialog>Cancel</button><button class="button primary">Create automation</button></div></div>
  </form>
</dialog>`;
}

// The message tester runs the server's own matcher, embedded from its source.
const newRuleScript = `
(() => {
  const keywordMatch = (${keywordMatch.toString()});
  const dialog = document.getElementById('new-rule');
  const form = dialog.querySelector('form');
  const taken = JSON.parse(dialog.dataset.taken || '{}');
  const suggested = JSON.parse(dialog.dataset.suggested || '[]').join(String.fromCharCode(10));
  const field = id => document.getElementById(id);
  const keywords = field('nr-keywords'), test = field('nr-test'), message = field('nr-message');
  const button = field('nr-button'), link = field('nr-link'), publicReply = field('nr-public'), name = field('nr-name');
  const turnOn = form.elements.namedItem('active');
  const reasons = { missing: 'it doesn’t include the keyword as its own word.', too_long: 'it’s too long. Only short messages trigger it.', extra_words: 'it has too many other words.' };
  const channelNames = { comments: 'comments', dms: 'DMs', stories: 'story replies' };
  const channelBoxes = [...form.querySelectorAll('input[type="checkbox"][name="channels"]')];
  let templateName = '';
  let nameEdited = false;
  const list = () => keywords.value.split(',').map(item => item.trim()).filter(Boolean);
  const show = (element, text) => { element.textContent = text; element.hidden = !text; };
  function update() {
    const items = list();
    const channels = channelBoxes.filter(box => box.checked).map(box => box.value);
    channelBoxes[0].setCustomValidity(channels.length ? '' : 'Choose at least one place to listen.');
    let keywordProblem = '';
    for (const item of items) {
      if (keywordMatch(item, item).reason === 'missing') { keywordProblem = '“' + item + '” can never match. Use letters or numbers.'; break; }
      if (keywordMatch(item, item).reason === 'too_long') { keywordProblem = '“' + item + '” is too long. Keep keywords to eight words or fewer.'; break; }
      const clash = turnOn.checked && (taken[item.toLowerCase()] || []).find(rule => rule.channels.some(channel => channels.includes(channel)));
      if (clash) {
        const shared = clash.channels.filter(channel => channels.includes(channel)).map(channel => channelNames[channel]).join(' and ');
        keywordProblem = item.toUpperCase() + ' is already used by “' + clash.label + '” for ' + shared + '. Pick a different keyword or place.';
        break;
      }
    }
    show(field('nr-keyword-error'), keywordProblem);
    keywords.setCustomValidity(keywordProblem);
    field('nr-public-step').hidden = !channels.includes('comments');

    const sample = test.value.trim();
    const result = field('nr-test-result');
    if (!items.length) { result.textContent = 'Add a keyword, then type a message to see if it would send.'; result.className = 'tester-result'; }
    else if (!sample) { result.textContent = 'Type a message to see if it would send.'; result.className = 'tester-result'; }
    else {
      const results = items.map(item => keywordMatch(sample, item));
      const hit = results.find(item => item.match);
      const closest = results.find(item => item.reason !== 'missing') || results[0];
      result.textContent = hit ? '✓ This would send the DM.' : '✕ No DM, because ' + reasons[closest.reason];
      result.className = 'tester-result ' + (hit ? 'yes' : 'no');
    }

    const buttonText = button.value.trim(), url = link.value.trim();
    const limit = buttonText || url ? 640 : 1000;
    const count = message.value.trim().length;
    const counter = field('nr-message-count');
    counter.textContent = count.toLocaleString() + ' / ' + limit.toLocaleString() + (limit === 640 ? ' with a button' : '');
    counter.classList.toggle('over', count > limit);
    message.setCustomValidity(count > limit ? 'Keep the message to ' + limit.toLocaleString() + ' characters' + (limit === 640 ? ' when it has a button.' : '.') : '');

    let validUrl = false;
    try { validUrl = new URL(url).protocol === 'https:'; } catch {}
    const buttonProblem = buttonText && !url ? 'Add the link this button opens.'
      : url && !buttonText ? 'Add button text, like “Open link”.'
      : url && !validUrl ? 'The link needs to start with https://' : '';
    show(field('nr-button-error'), buttonProblem);
    button.setCustomValidity(url && !buttonText ? buttonProblem : '');
    link.setCustomValidity((buttonText && !url) || (url && !validUrl) ? buttonProblem : '');

    if (!nameEdited) name.value = templateName || (items[0] ? items[0].charAt(0).toUpperCase() + items[0].slice(1).toLowerCase() : '');

    const shown = sample || (items[0] || 'keyword').toUpperCase();
    const asComment = !channels.length || channels.includes('comments');
    field('nrp-as-comment').hidden = !asComment;
    field('nrp-as-dm').hidden = asComment;
    field('nrp-dm-caption').textContent = channels[0] === 'stories' ? 'Replying to your story' : 'In your DMs';
    field('nrp-dm-text').textContent = shown;
    field('nrp-comment').textContent = shown;
    field('nrp-message').textContent = message.value.trim() || 'Your message appears here.';
    const previewButton = field('nrp-button');
    previewButton.hidden = !buttonText;
    previewButton.textContent = buttonText + ' ↗';
    const replies = publicReply.value.split(String.fromCharCode(10)).map(item => item.trim()).filter(Boolean);
    field('nrp-public-wrap').hidden = !replies.length || !channels.includes('comments');
    field('nrp-public').textContent = replies[0] || '';
    field('nrp-status').textContent = sample && items.length && !result.classList.contains('yes') ? 'This message wouldn’t get a DM.' : replies.length > 1 && channels.includes('comments') ? 'Public reply shown is 1 of ' + replies.length + '.' : '';
  }
  name.addEventListener('input', () => { nameEdited = name.value.trim() !== ''; });
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  dialog.querySelectorAll('[data-template]').forEach(choice => choice.addEventListener('click', () => {
    const template = JSON.parse(choice.dataset.template);
    dialog.querySelectorAll('[data-template]').forEach(item => item.setAttribute('aria-pressed', String(item === choice)));
    keywords.value = template.keyword || '';
    message.value = template.message || '';
    button.value = template.button || '';
    link.value = '';
    publicReply.value = template.keyword ? suggested : '';
    test.value = '';
    templateName = template.name || '';
    nameEdited = false;
    update();
    (template.keyword ? link : keywords).focus();
  }));
  field('nr-suggest').addEventListener('click', () => { publicReply.value = suggested; update(); });
  document.querySelectorAll('.rule-card form').forEach(editForm => {
    const boxes = [...editForm.querySelectorAll('input[type="checkbox"][name="channels"]')];
    const check = () => boxes[0] && boxes[0].setCustomValidity(boxes.some(box => box.checked) ? '' : 'Choose at least one place to listen.');
    editForm.addEventListener('change', check);
    check();
  });
  dialog.querySelectorAll('[data-close-dialog]').forEach(element => element.addEventListener('click', () => dialog.close()));
  update();
})();
`;

const clientScript = `
const dialog = document.getElementById('new-rule');
document.querySelectorAll('[data-new-rule]').forEach(button => button.addEventListener('click', () => dialog.showModal()));
document.querySelector('.close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
document.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', event => { if (!confirm('Delete this automation?')) event.preventDefault(); }));
const previewPanel = document.getElementById('reply-preview');
const previewMessage = document.getElementById('preview-message');
const previewButtons = document.getElementById('preview-buttons');
const channelTitles = { comments: 'Comments', dms: 'DMs', stories: 'Story replies' };
function validPreviewUrl(value) { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null; } catch { return null; } }
function previewLink(title, url) { const link = document.createElement('a'); const href = validPreviewUrl(url); link.textContent = title; if (href) { link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; } return link; }
function showPreview(config) {
  document.getElementById('preview-heading').textContent = config.title || 'Reply preview';
  document.getElementById('preview-keyword').textContent = config.keyword || 'KEYWORD';
  document.getElementById('preview-source').textContent = config.source;
  previewPanel.setAttribute('aria-label', (config.title || 'Reply') + ' preview');
  previewMessage.textContent = config.text || 'Your message appears here.';
  previewButtons.replaceChildren();
  (config.buttons || []).forEach(button => { if (validPreviewUrl(button.url)) previewButtons.append(previewLink(button.title + ' ↗', button.url)); });
  const publicReplies = config.comments ? (config.publicReply || '').split(String.fromCharCode(10)).map(text => text.trim()).filter(Boolean) : [];
  document.getElementById('preview-public').hidden = !publicReplies.length;
  document.getElementById('preview-public-label').textContent = publicReplies.length > 1 ? 'Public reply · 1 of ' + publicReplies.length : 'Public reply';
  document.getElementById('preview-public-text').textContent = publicReplies[0] || '';
  document.getElementById('preview-note').textContent = config.active ? 'Updates as you edit. Nothing is sent.' : 'Paused. This automation won’t send replies.';
}
function previewRule(card) {
  const config = JSON.parse(card.dataset.preview);
  const form = card.querySelector('form');
  const channels = [...form.querySelectorAll('input[type="checkbox"][name="channels"]:checked')].map(box => box.value);
  config.title = form.elements.namedItem('label').value || 'Reply';
  config.keyword = form.elements.namedItem('keywords').value.split(',')[0].trim().toUpperCase();
  config.active = form.elements.namedItem('active').checked;
  config.comments = channels.includes('comments');
  config.source = (channels.map(channel => channelTitles[channel]).join(', ') || 'Nowhere yet') + ' → DM';
  config.publicReply = form.elements.namedItem('public_reply_text').value;
  config.text = form.elements.namedItem('reply_text').value;
  config.buttons = [{ title: form.elements.namedItem('link_button_label').value, url: form.elements.namedItem('link_url').value }].filter(button => button.title && button.url);
  showPreview(config);
}
document.querySelectorAll('.rule-card').forEach(card => {
  card.addEventListener('toggle', () => { if (card.open) previewRule(card); });
  card.addEventListener('focusin', () => { if (card.open) previewRule(card); });
  card.addEventListener('input', () => previewRule(card));
  card.addEventListener('change', () => previewRule(card));
});
const tabs = [...document.querySelectorAll('[data-tab]')];
function selectTab(tab) { tabs.forEach(item => { const active = item === tab; item.setAttribute('aria-selected', String(active)); item.tabIndex = active ? 0 : -1; document.getElementById(item.dataset.tab).hidden = !active; }); }
tabs.forEach((tab, index) => { tab.addEventListener('click', () => selectTab(tab)); tab.addEventListener('keydown', event => { if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; tabs[next].focus(); selectTab(tabs[next]); } }); });
if (location.hash === '#messages' && tabs[1]) selectTab(tabs[1]);
const navLinks = [...document.querySelectorAll('.site-nav a[href^="#"]')];
navLinks.forEach(link => link.addEventListener('click', () => { navLinks.forEach(item => item === link ? item.setAttribute('aria-current', 'page') : item.removeAttribute('aria-current')); }));
const localTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
document.querySelectorAll('main time[datetime]').forEach(element => { const date = new Date(element.dateTime); if (!Number.isNaN(date.getTime())) { element.textContent = localTime.format(date); element.title = date.toLocaleString(); } });
document.querySelectorAll('form').forEach(form => form.addEventListener('submit', () => { form.setAttribute('aria-busy', 'true'); }));
`;

const styles = `
.shell{max-width:1120px;margin:0 auto;padding:0 32px}
.icon{width:16px;height:16px;flex:none;vertical-align:middle}
.muted{color:var(--muted)}
.notices{display:flex;flex-direction:column;gap:8px;padding-top:24px}
.flash{background:var(--accent-soft);color:var(--accent);border-radius:8px;padding:10px 14px;font-size:13px}
.overview{padding-top:48px}
.page-head{display:flex;align-items:baseline;gap:12px;margin-bottom:24px}
.page-head h1{font-size:26px;font-weight:600;letter-spacing:-.02em;color:var(--ink)}
.page-head span{font-size:14px;color:var(--faint)}
.figures{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.figure{padding:20px 24px 22px;border-left:1px solid var(--line);min-width:0}
.figure:first-child{border-left:0;padding-left:0}
.figure dt{font-size:13px;color:var(--muted)}
.figure-value{font-size:32px;font-weight:500;letter-spacing:-.03em;line-height:1.2;color:var(--ink);font-variant-numeric:tabular-nums;margin:6px 0 2px}
.figure-detail{font-size:12.5px;color:var(--faint)}
.figure.danger .figure-value{color:var(--danger)}
.block{padding-top:56px}
.block-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:14px}
.block-head h2{font-size:17px;font-weight:600;letter-spacing:-.01em;color:var(--ink)}
.block-sub{font-size:13px;color:var(--muted);margin-top:3px}
.link{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:500;color:var(--accent);white-space:nowrap}
.link:hover{text-decoration:underline;text-underline-offset:3px}
.link.quiet{color:var(--muted);font-weight:400}
.link .icon{width:14px;height:14px}
.empty{color:var(--muted);padding:20px 0;font-size:13.5px;border-top:1px solid var(--line)}
.recent-dms{border-top:1px solid var(--line)}
.recent-dms .dm-row{background:transparent;border:0;border-bottom:1px solid var(--line);border-radius:0;margin:0;padding:14px 0}
.automations-layout{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:40px;align-items:start}
.auto-list{border-top:1px solid var(--line)}
.auto-list>.empty{border-top:0}
.auto{border-bottom:1px solid var(--line)}
.auto>summary{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) 64px 64px 16px;gap:16px;align-items:center;padding:14px 6px;margin:0 -6px;border-radius:6px;cursor:pointer;list-style:none;transition:background .15s}
.auto>summary::-webkit-details-marker{display:none}
.auto>summary:hover{background:#f3f3ef}
.auto-name{display:flex;flex-direction:column;min-width:0}
.auto-name strong{font-weight:500;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.auto-name span{font-size:12.5px;color:var(--faint)}
.auto-keys{font-family:var(--mono);font-size:12px;letter-spacing:.02em;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.auto-keys .sep{font-family:var(--sans)}
.auto-sent{font-size:13px;color:var(--muted);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.auto-state{font-size:13px;color:var(--faint);white-space:nowrap}
.auto-state.on{color:var(--accent)}
.auto-state.on:before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;margin-right:7px;vertical-align:2px}
.chevron{width:16px;height:16px;color:var(--faint);transition:transform .2s}
.auto[open] .chevron{transform:rotate(180deg)}
.paused .auto-name strong{color:var(--muted)}
.auto-edit{display:flex;flex-direction:column;gap:16px;padding:6px 0 28px}
.preview-panel{position:sticky;top:84px;background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.preview-heading{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line);font-size:13px;font-weight:500;color:var(--ink)}
.preview-heading>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.preview-tag{font-size:12px;font-weight:400;color:var(--faint)}
.chat{display:flex;flex-direction:column;gap:10px;padding:16px;background:#fcfcfa}
.chat-date{text-align:center;font-size:11.5px;color:var(--faint)}
.incoming{align-self:flex-end;max-width:80%;background:#ebeae5;color:var(--ink);border-radius:16px 16px 4px 16px;padding:7px 12px;font-size:13.5px;overflow-wrap:anywhere}
.chat-reply{display:flex;flex-direction:column;gap:6px;max-width:90%}
.bubble{background:var(--surface);border:1px solid var(--line);border-radius:16px 16px 16px 4px;padding:9px 12px;font-size:13.5px;white-space:pre-wrap;overflow-wrap:anywhere}
.chat-buttons{display:flex;flex-direction:column;gap:6px}
.chat-buttons>a{display:flex;align-items:center;justify-content:center;gap:6px;background:var(--surface);border:1px solid var(--line-strong);border-radius:10px;padding:7px 10px;font-size:13px;font-weight:500;color:var(--accent)}
.public-preview{margin-top:4px;padding-top:10px;border-top:1px dashed var(--line-strong)}
.public-preview>span{font-size:11.5px;color:var(--faint)}
.public-preview>p{font-size:13px;margin-top:2px;white-space:pre-wrap;overflow-wrap:anywhere}
.preview-note{padding:10px 16px;border-top:1px solid var(--line);font-size:12px;color:var(--faint)}
.table-scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:500;font-size:12.5px;color:var(--faint);padding:0 16px 10px 0;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:12px 16px 12px 0;border-bottom:1px solid var(--line);vertical-align:top;font-variant-numeric:tabular-nums;white-space:nowrap}
td strong{font-weight:500;color:var(--ink)}
.table-sub{font-size:12px;color:var(--faint)}
.table-foot{margin-top:12px}
.sent-value{font-weight:500;color:var(--accent)}
.error-value{color:var(--danger)}
.activity-links{display:flex;gap:20px}
.activity-tabs{display:flex;gap:24px;border-bottom:1px solid var(--line);margin-bottom:18px}
.activity-tabs>button{background:none;border:0;border-bottom:1.5px solid transparent;padding:0 0 10px;margin-bottom:-1px;font-size:13.5px;color:var(--muted)}
.activity-tabs>button[aria-selected=true]{color:var(--ink);border-bottom-color:var(--ink);font-weight:500}
.activity-tabs>button>span{color:var(--faint);margin-left:4px;font-weight:400;font-variant-numeric:tabular-nums}
.filters{display:grid;grid-template-columns:repeat(4,minmax(0,1fr)) auto auto;gap:12px;align-items:end;margin-bottom:18px}
.filters .text-link{height:34px}
.list-note{margin-bottom:12px}
.list-foot{margin-top:12px}
.events{border-top:1px solid var(--line)}
.event{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;padding:14px 0;border-bottom:1px solid var(--line)}
.event-title{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.event-title strong{font-weight:500;color:var(--ink);overflow-wrap:anywhere}
.event-title time{font-size:12.5px;color:var(--faint)}
.event-body{min-width:0}
.event-body>p{margin:3px 0 4px;overflow-wrap:anywhere}
.event-rule{font-size:12.5px;color:var(--faint)}
.event-rule>span{color:var(--muted)}
.event-state{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.event-state form{margin:0}
.event-state .text-link{font-size:12.5px}
.status{font-size:12.5px;color:var(--faint);white-space:nowrap}
.status.ok{color:var(--accent)}
.status.danger{color:var(--danger)}
.status.warn{color:var(--warn)}
.error-details{margin-top:6px;font-size:12.5px;color:var(--danger)}
.error-details summary{cursor:pointer;width:fit-content}
.error-details p{margin-top:4px;overflow-wrap:anywhere}
.settings{padding-top:72px}
.settings>.block-head{margin-bottom:0;padding-bottom:14px}
.setting{display:grid;grid-template-columns:240px minmax(0,1fr);gap:48px;padding:28px 0;border-top:1px solid var(--line)}
.setting-intro h3{font-size:14.5px;font-weight:600;color:var(--ink)}
.setting-intro p{font-size:13px;color:var(--muted);margin-top:4px}
.setting-intro .field-help{margin-top:8px}
.setting-intro .tag{margin-top:12px}
.setting-body{display:flex;flex-direction:column;gap:16px;min-width:0}
.connection-handle{font-weight:500;color:var(--ink)}
.connection-dates{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
.connection-dates dt{font-size:12.5px;color:var(--faint);margin-bottom:2px}
.connection-dates dd{font-size:13px}
.channel-picker{border:0;margin:0;padding:0;min-width:0}
.channel-picker legend{padding:0;margin-bottom:6px;font-size:13px;font-weight:500;color:var(--ink)}
.channels{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.channel{display:flex;gap:9px;align-items:flex-start;padding:10px 12px;border:1px solid var(--line-strong);border-radius:8px;background:var(--surface);cursor:pointer;font-weight:400;transition:border-color .15s,background .15s}
.channel:hover{border-color:var(--faint)}
.channel:has(input:checked){border-color:var(--accent);background:var(--accent-soft)}
.channel input{margin:2px 0 0;accent-color:var(--accent);flex:none}
.channel span{display:flex;flex-direction:column;min-width:0}
.channel strong{font-size:13px;font-weight:500;color:var(--ink)}
.channel small{font-size:12px;color:var(--muted);line-height:1.4}
dialog{border:1px solid var(--line);border-radius:14px;width:min(540px,calc(100% - 32px));max-height:calc(100dvh - 48px);overflow:auto;padding:28px;background:var(--surface);color:var(--text);box-shadow:0 24px 80px #15191626}
dialog::backdrop{background:#15191640;backdrop-filter:blur(2px)}
.dialog-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:20px}
.dialog-heading h2{font-size:17px;font-weight:600;color:var(--ink)}
.close-dialog{background:none;border:0;padding:2px 6px;font-size:22px;line-height:1;color:var(--faint)}
.close-dialog:hover{color:var(--ink)}
dialog.new-rule{width:min(900px,calc(100% - 32px));padding:0}
.new-rule .dialog-heading{align-items:flex-start;padding:24px 28px 0;margin-bottom:16px}
.dialog-sub{font-size:13px;color:var(--muted);margin-top:3px}
.templates{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:0 28px 18px;border-bottom:1px solid var(--line)}
.templates-label{font-size:12.5px;color:var(--faint);margin-right:4px}
.template{background:var(--surface);border:1px solid var(--line-strong);border-radius:999px;padding:4px 12px;font-size:12.5px;color:var(--text)}
.template:hover{border-color:var(--faint)}
.template[aria-pressed=true]{background:var(--ink);border-color:var(--ink);color:#fff}
.new-rule-grid{display:grid;grid-template-columns:minmax(0,1fr) 290px}
.new-rule-fields{padding:4px 28px 4px;min-width:0}
.step{border:0;margin:0;padding:18px 0 20px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:12px;min-width:0}
.step:last-child{border-bottom:0}
.step legend{padding:0;margin-bottom:12px;font-size:14px;font-weight:600;color:var(--ink)}
.step legend .optional{font-size:13px}
.tester{background:#f6f6f2;border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px}
.tester-result{font-size:13px;color:var(--muted)}
.tester-result.yes{color:var(--accent);font-weight:500}
.tester-result.no{color:var(--danger)}
.field-error{font-size:12.5px;color:var(--danger)}
.counter{text-align:right;font-variant-numeric:tabular-nums}
.counter.over{color:var(--danger)}
.step-help{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
.new-rule-preview{background:#f6f6f2;border-left:1px solid var(--line);padding:22px 20px;display:flex;flex-direction:column;gap:10px}
.preview-label{font-size:12.5px;color:var(--faint);margin-bottom:4px}
.ig-comment{display:flex;gap:9px;align-items:flex-start;font-size:13.5px}
.ig-comment p{overflow-wrap:anywhere;min-width:0}
.ig-comment strong{font-weight:600;color:var(--ink)}
.ig-reply{margin-left:28px;font-size:13px}
.ig-avatar{width:24px;height:24px;border-radius:50%;background:#dcdbd4;flex:none}
.ig-avatar.you{width:20px;height:20px;background:var(--accent)}
#nrp-as-dm{display:flex;flex-direction:column;gap:8px}
#nrp-as-dm .incoming{align-self:flex-end}
.preview-divider{font-size:11.5px;color:var(--faint);text-align:center;margin:10px 0 2px}
.new-rule-preview .chat-reply{max-width:100%}
.preview-status{font-size:12px;color:var(--faint)}
.dialog-more{padding:14px 28px;font-size:12.5px;color:var(--faint);border-top:1px solid var(--line)}
.dialog-more a{color:var(--accent);text-decoration:underline;text-underline-offset:2px}
.dialog-footer{position:sticky;bottom:0;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 28px;border-top:1px solid var(--line);background:var(--surface)}
.dialog-footer>div{display:flex;gap:8px}
.site-footer{max-width:1120px;margin:0 auto;padding:72px 32px 40px;display:flex;justify-content:space-between;gap:16px;font-size:12.5px;color:var(--faint)}
.site-footer a{display:inline-flex;align-items:center;gap:5px}
.site-footer a:hover{color:var(--ink)}
.site-footer .icon{width:12px;height:12px}
form[aria-busy=true] button{opacity:.6}
@media(max-width:1000px){.automations-layout{grid-template-columns:1fr}.preview-panel{position:static;max-width:420px}.filters{grid-template-columns:1fr 1fr}.connection-dates{grid-template-columns:1fr 1fr}}
@media(max-width:860px){.setting{grid-template-columns:1fr;gap:16px}}
@media(max-width:760px){.shell{padding:0 20px}.overview{padding-top:32px}.figures{grid-template-columns:1fr 1fr}.figure:nth-child(3){border-left:0;padding-left:0}.figure:nth-child(n+3){border-top:1px solid var(--line)}.figure{padding:16px 0 18px 20px}.figure-value{font-size:28px}.block{padding-top:44px}.block-head{align-items:flex-start;flex-direction:column;gap:10px}.site-footer{padding:56px 20px 32px}.channels{grid-template-columns:1fr}.new-rule-grid{grid-template-columns:1fr}.new-rule-preview{border-left:0;border-top:1px solid var(--line)}.new-rule .dialog-heading,.templates,.new-rule-fields,.dialog-more,.dialog-footer{padding-left:20px;padding-right:20px}}
@media(max-width:640px){.auto>summary{grid-template-columns:minmax(0,1fr) auto 16px;row-gap:2px}.auto-name{grid-column:1;grid-row:1}.auto-state{grid-column:2;grid-row:1}.chevron{grid-column:3;grid-row:1}.auto-keys{grid-column:1;grid-row:2}.auto-sent{grid-column:2;grid-row:2;text-align:left}.filters{grid-template-columns:1fr}.event{grid-template-columns:1fr;gap:6px}.event-state{align-items:flex-start;flex-direction:row;gap:12px}.dialog-footer{flex-wrap:wrap}}
`;

function renderAccessPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(title)} · ${PRODUCT_NAME} for Instagram</title><style>${baseStyles}${formStyles}
  .login-shell{min-height:100dvh;display:grid;place-items:center;padding:24px}.login-panel{width:100%;max-width:360px}.login-panel .wordmark{margin-bottom:48px}.login-panel h1{font-size:22px;font-weight:600;letter-spacing:-.02em;line-height:1.3;color:var(--ink);margin-bottom:20px;overflow-wrap:anywhere}.login-panel .eyebrow{font-size:13px;color:var(--muted);margin-bottom:6px}.login-panel button{width:100%;height:38px;background:var(--accent);color:#fff;border:0;border-radius:7px;font-size:14px;font-weight:500}.login-panel button:hover{background:var(--accent-hover)}.login-panel .alert{padding:10px 12px;border-radius:7px;background:var(--danger-soft);color:var(--danger);font-size:13px;margin-bottom:16px}.login-panel a{color:var(--accent);text-decoration:underline;text-underline-offset:2px}.login-panel pre{white-space:pre-wrap;font:12.5px/1.5 var(--mono);background:#f0efea;border-radius:7px;padding:12px;margin:16px 0 0}.login-panel p.muted{font-size:13px;color:var(--muted)}
  </style></head><body>${body}</body></html>`;
}

const wordmark = `<span class="wordmark"><span class="wordmark-name">${PRODUCT_NAME}</span><span class="wordmark-product">Instagram</span></span>`;

export function renderLoginPage(invalid: boolean): string {
  return renderAccessPage("Sign in", `
    <main class="login-shell">
      <section class="login-panel">
        ${wordmark}
        <h1>Sign in</h1>
        ${invalid ? '<p class="alert">That token did not match.</p>' : ""}
        <form method="post" action="/admin/login" class="stack">
          <label>
            <span>Admin token</span>
            <input name="token" type="password" autocomplete="current-password" autofocus required>
          </label>
          <button type="submit">Open dashboard</button>
        </form>
      </section>
    </main>
  `);
}

export function renderMissingAdminTokenPage(): string {
  return renderAccessPage("Admin token missing", `
    <main class="login-shell">
      <section class="login-panel">
        ${wordmark}
        <p class="eyebrow">Setup needed</p>
        <h1>Set ADMIN_TOKEN</h1>
        <p class="muted">Create an admin token before using the dashboard.</p>
        <pre>npx wrangler secret put ADMIN_TOKEN</pre>
      </section>
    </main>
  `);
}

export function renderErrorPage(message: string): string {
  return renderAccessPage("Error", `
    <main class="login-shell">
      <section class="login-panel">
        ${wordmark}
        <p class="eyebrow">Couldn’t save</p>
        <h1>${esc(message)}</h1>
        <p><a href="/admin">Back to dashboard</a></p>
      </section>
    </main>
  `);
}
