import { parseReplyRef } from "./dm-features";
import { isBasicallyKeyword } from "./keyword-match";
import { baseStyles, headerStyles, PRODUCT_NAME, renderHeader } from "./theme";

// The Sent DMs page (/admin/sent) and the dashboard's Recent DMs list.
export type SentDmRow = {
  kind: "comment" | "dm";
  id: string;
  username: string | null;
  sender_id: string | null;
  trigger_text: string;
  // The keyword a comment matched. DM rows work it out from rule_keywords.
  matched_keyword: string | null;
  // JSON keywords of the automation a DM reply came from (reply key rule-<id>).
  rule_keywords: string | null;
  reply_label: string | null;
  source: string;
  quick_reply_payload: string | null;
  referral_ref: string | null;
  status: string;
  error: string | null;
  received_at: string;
  sent_at: string | null;
};

export type SentDmSummary = { sent: number; failed: number };

export const SENT_DMS_LIMIT = 100;

/**
 * Outgoing DMs only: comment private replies and replies to incoming messages,
 * including failed attempts. `+status` keeps SQLite on the received_at indexes,
 * so the page's polling reads about `limit` rows instead of every sent row.
 */
export async function getSentDms(db: D1Database, limit = SENT_DMS_LIMIT): Promise<SentDmRow[]> {
  const result = await db.prepare(
    `SELECT * FROM (
       SELECT 'comment' AS kind, comment_id AS id, username, NULL AS sender_id, comment_text AS trigger_text,
         matched_keyword, NULL AS rule_keywords, rule_label AS reply_label, 'comment' AS source,
         NULL AS quick_reply_payload, NULL AS referral_ref, status, error, received_at, sent_at
       FROM comment_events
       WHERE +status IN ('sent', 'sent_public_reply_error', 'send_error')
       ORDER BY received_at DESC LIMIT ?
     )
     UNION ALL
     SELECT * FROM (
       SELECT 'dm', m.message_id, m.sender_username, m.sender_id, m.message_text, NULL, r.keywords, m.matched_choice,
         m.source, m.quick_reply_payload, m.referral_ref, m.status, m.error, m.received_at, m.sent_at
       FROM (
         SELECT * FROM message_events
         WHERE +status IN ('sent', 'send_error')
         ORDER BY received_at DESC LIMIT ?
       ) m
       LEFT JOIN rules r ON m.reply_key LIKE 'rule-%' AND r.id = CAST(substr(m.reply_key, 6) AS INTEGER)
     )
     ORDER BY received_at DESC LIMIT ?`
  ).bind(limit, limit, limit).all<SentDmRow>();
  return result.results;
}

/** DMs sent and failed in the last 24 hours. A failed public reply still delivered its DM. */
export async function getSentDmSummary(db: D1Database, now: Date): Promise<SentDmSummary> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const row = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM comment_events WHERE received_at >= ? AND +status IN ('sent', 'sent_public_reply_error')) +
       (SELECT COUNT(*) FROM message_events WHERE received_at >= ? AND +status = 'sent') AS sent,
       (SELECT COUNT(*) FROM comment_events WHERE received_at >= ? AND +status = 'send_error') +
       (SELECT COUNT(*) FROM message_events WHERE received_at >= ? AND +status = 'send_error') AS failed`
  ).bind(since, since, since, since).first<SentDmSummary>();
  return row ?? { sent: 0, failed: 0 };
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Marks every place the keyword appears, and reports a match that only hit part of a word. */
function highlightKeyword(text: string, keyword: string | null): { html: string; partialWord: string | null } {
  if (!keyword?.trim()) return { html: esc(text), partialWord: null };
  const pattern = new RegExp(keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  let html = "";
  let cursor = 0;
  let partialWord: string | null = null;
  let wholeWord = false;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    html += `${esc(text.slice(cursor, start))}<mark>${esc(match[0])}</mark>`;
    cursor = end;
    const before = /[\p{L}\p{N}_]*$/u.exec(text.slice(0, start))?.[0] ?? "";
    const after = /^[\p{L}\p{N}_]*/u.exec(text.slice(end))?.[0] ?? "";
    if (before || after) partialWord ??= before + match[0] + after;
    else wholeWord = true;
  }
  return { html: html + esc(text.slice(cursor)), partialWord: wholeWord ? null : partialWord };
}

/** Comments store their keyword. A typed DM or story reply finds it among the automation's keywords. */
function matchedKeyword(row: SentDmRow): string | null {
  if (row.kind === "comment") return row.matched_keyword;
  // Starter taps carry the button title as their text, so only typed messages count.
  if (!row.rule_keywords || !["dm", "story_reply", "referral"].includes(row.source)) return null;
  try {
    const keywords: unknown = JSON.parse(row.rule_keywords);
    if (!Array.isArray(keywords)) return null;
    return keywords.find((keyword): keyword is string => typeof keyword === "string" && isBasicallyKeyword(row.trigger_text, keyword)) ?? null;
  } catch {
    return null;
  }
}

function who(row: SentDmRow): string {
  const handle = row.username?.replace(/^@/, "") ?? "";
  if (/^[A-Za-z0-9._]{1,30}$/.test(handle)) {
    return `<a class="who" href="https://www.instagram.com/${handle}/" target="_blank" rel="noopener noreferrer">@${esc(handle)}</a>`;
  }
  if (handle) return `<strong class="who">@${esc(handle)}</strong>`;
  return `<strong class="who">Instagram user …${esc((row.sender_id ?? "").slice(-4))}</strong>`;
}

function trigger(row: SentDmRow): string {
  switch (row.source) {
    case "comment": return "commented";
    case "starter": return "tapped a conversation starter";
    case "postback": return "tapped a button";
    case "story_reply": return "replied to your story";
    case "story_mention": return "mentioned you in a story";
    case "referral": {
      const source = parseReplyRef(row.referral_ref)?.source;
      return source ? `opened your DM link from ${source}` : "opened your DM link";
    }
    default: return row.quick_reply_payload ? "tapped a reply button" : "messaged you";
  }
}

const REPLY_NAMES: Record<string, string> = { "Fallback rule": "the fallback reply (KEYWORD)" };

function sentRow(row: SentDmRow): string {
  const key = `${row.kind}:${row.id}`;
  const failed = row.status === "send_error";
  const keyword = matchedKeyword(row);
  const { html: said, partialWord } = highlightKeyword(row.trigger_text, keyword);
  const reply = REPLY_NAMES[row.reply_label ?? ""] ?? row.reply_label ?? "a reply";
  const time = new Date(row.sent_at ?? row.received_at);
  const iso = Number.isNaN(time.getTime()) ? row.received_at : time.toISOString();
  const fallbackTime = Number.isNaN(time.getTime()) ? row.received_at : `${time.toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC"
  })} UTC`;
  const search = [row.username ?? "", row.trigger_text, reply].join(" ").toLowerCase();
  return `<article class="dm-row" data-id="${esc(key)}" data-key="${esc(`${key}:${row.status}`)}" data-kind="${row.kind}" data-failed="${failed ? 1 : 0}" data-search="${esc(search)}">
    <time datetime="${esc(iso)}">${esc(fallbackTime)}</time>
    <div class="dm-main">
      <div class="dm-line">${who(row)}<span class="why">${esc(trigger(row))}</span>${keyword ? `<span class="keyword">matched ${esc(keyword.toUpperCase())}</span>` : ""}${partialWord ? `<span class="partial" title="The keyword matched inside a longer word. Automations now need the whole word.">inside “${esc(partialWord)}”</span>` : ""}</div>
      ${row.trigger_text ? `<p class="said" title="${esc(row.trigger_text)}">${said}</p>` : ""}
      ${failed && row.error ? `<p class="note">${esc(row.error)}</p>` : ""}
      ${row.status === "sent_public_reply_error" ? '<p class="note">DM sent. The public comment reply failed.</p>' : ""}
    </div>
    <div class="sent ${failed ? "failed" : ""}">${failed ? "Didn’t send" : `Sent ${esc(reply)}`}</div>
  </article>`;
}

export function renderSentRows(rows: SentDmRow[]): string {
  return rows.map(sentRow).join("");
}

export function renderSentSummary(summary: SentDmSummary): string {
  const sent = `<strong>${summary.sent.toLocaleString("en-US")}</strong> DM${summary.sent === 1 ? "" : "s"} sent in the last 24 hours`;
  return summary.failed ? `${sent} · <span class="failed-count">${summary.failed.toLocaleString("en-US")} didn’t send</span>` : sent;
}

export function renderSentDmsPage(data: { rows: SentDmRow[]; summary: SentDmSummary; dryRun: boolean }): string {
  const status = '<span id="live" class="mode" role="status" aria-live="polite"><i></i><span>Live</span></span>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>Sent DMs · ${PRODUCT_NAME} for Instagram</title><style>${baseStyles}${headerStyles}${pageStyles}${sentRowStyles}</style></head><body>
  <a class="skip" href="#main">Skip to content</a>
  ${renderHeader("sent", status)}
  <main id="main" class="wrap">
    <h1>Sent DMs</h1>
    <p class="lede">Every DM your automations sent, and what the person did to get it. New ones appear on their own.</p>
    ${data.dryRun ? '<p class="notice">Test mode is on, so nothing is being sent. Matches show up under Activity on the dashboard.</p>' : ""}
    <p id="sent-summary" class="summary">${renderSentSummary(data.summary)}</p>
    <div class="controls">
      <div class="tabs" role="group" aria-label="Show">
        <button type="button" data-filter="all" aria-pressed="true">All <span data-count="all"></span></button>
        <button type="button" data-filter="comment" aria-pressed="false">From comments <span data-count="comment"></span></button>
        <button type="button" data-filter="dm" aria-pressed="false">From DMs <span data-count="dm"></span></button>
        <button type="button" data-filter="failed" aria-pressed="false">Didn’t send <span data-count="failed"></span></button>
      </div>
      <input id="sent-search" type="search" placeholder="Search a name or message" aria-label="Search a name or message">
    </div>
    <div id="sent-list">${renderSentRows(data.rows)}</div>
    <p id="sent-empty" class="empty" ${data.rows.length ? "hidden" : ""}>${data.rows.length ? "No DMs match." : "No DMs sent yet."}</p>
    <p class="foot">Latest ${SENT_DMS_LIMIT} · Times are in your time zone.</p>
  </main><script>${clientScript}</script></body></html>`;
}

const clientScript = `
(() => {
  const list = document.getElementById('sent-list');
  const summary = document.getElementById('sent-summary');
  const empty = document.getElementById('sent-empty');
  const search = document.getElementById('sent-search');
  const live = document.getElementById('live');
  const buttons = [...document.querySelectorAll('[data-filter]')];
  const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const longDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  let filter = 'all';
  let lastChecked = Date.now();
  let state = 'ok';

  const rows = () => [...list.querySelectorAll('.dm-row')];
  const signature = (items) => items.map(row => row.dataset.key).join(',');
  const matchesFilter = (row) => filter === 'all' || (filter === 'failed' ? row.dataset.failed === '1' : row.dataset.kind === filter);

  function dayLabel(date) {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return longDay.format(date);
  }

  function decorate() {
    list.querySelectorAll('.day').forEach(heading => heading.remove());
    const query = search.value.trim().toLowerCase();
    const counts = { all: 0, comment: 0, dm: 0, failed: 0 };
    let lastDay = '';
    let shown = 0;
    for (const row of rows()) {
      counts.all++;
      counts[row.dataset.kind]++;
      if (row.dataset.failed === '1') counts.failed++;
      const time = row.querySelector('time');
      const date = new Date(time.dateTime);
      if (!Number.isNaN(date.getTime())) { time.textContent = clock.format(date); time.title = date.toLocaleString(); }
      row.hidden = !matchesFilter(row) || Boolean(query && !row.dataset.search.includes(query));
      if (row.hidden) continue;
      shown++;
      const label = Number.isNaN(date.getTime()) ? '' : dayLabel(date);
      if (label && label !== lastDay) {
        const heading = document.createElement('h2');
        heading.className = 'day';
        heading.textContent = label;
        row.before(heading);
        lastDay = label;
      }
    }
    for (const [key, value] of Object.entries(counts)) {
      const badge = document.querySelector('[data-count="' + key + '"]');
      if (badge) badge.textContent = value;
    }
    empty.hidden = shown > 0;
    empty.textContent = counts.all ? 'No DMs match.' : 'No DMs sent yet.';
  }

  function showLive() {
    const seconds = Math.round((Date.now() - lastChecked) / 1000);
    const label = live.querySelector('span');
    live.className = 'mode ' + (state === 'ok' ? '' : state === 'signed-out' ? 'off' : state);
    if (state === 'signed-out') label.innerHTML = 'Signed out · <a href="/admin">Sign in</a>';
    else if (state === 'error') label.textContent = 'Can’t reach the server · retrying';
    else label.textContent = 'Live · checked ' + (seconds < 5 ? 'just now' : seconds < 60 ? seconds + 's ago' : Math.round(seconds / 60) + 'm ago');
  }

  let inFlight = false;
  async function poll() {
    if (document.hidden || inFlight || state === 'signed-out') return;
    inFlight = true;
    try {
      const response = await fetch('/admin/sent?format=json', { headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' });
      if (response.status === 401) { state = 'signed-out'; return; }
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      summary.innerHTML = data.summary;
      const template = document.createElement('template');
      template.innerHTML = data.rows;
      const incoming = [...template.content.querySelectorAll('.dm-row')];
      if (signature(incoming) !== signature(rows())) {
        const known = new Set(rows().map(row => row.dataset.id));
        list.replaceChildren(template.content);
        rows().forEach(row => { if (!known.has(row.dataset.id)) row.classList.add('fresh'); });
        decorate();
      }
      state = 'ok';
      lastChecked = Date.now();
    } catch {
      state = 'error';
    } finally {
      inFlight = false;
      showLive();
    }
  }

  buttons.forEach(button => button.addEventListener('click', () => {
    filter = button.dataset.filter;
    buttons.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    decorate();
  }));
  search.addEventListener('input', decorate);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  decorate();
  showLive();
  setInterval(poll, 15000);
  setInterval(showLive, 5000);
})();
`;

const pageStyles = `
.wrap{max-width:880px;margin:0 auto;padding:48px 32px 72px}
h1{font-size:26px;font-weight:600;letter-spacing:-.02em;color:var(--ink);margin:0 0 6px}
.lede{color:var(--muted);margin:0 0 20px;max-width:60ch}
.notice{background:var(--warn-soft);color:var(--warn);border-radius:8px;padding:10px 14px;font-size:13px;margin-bottom:16px}
.summary{margin:0 0 24px;font-size:14px;color:var(--muted)}.summary strong{color:var(--ink);font-weight:600}.failed-count{color:var(--danger)}
.controls{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:4px}
.tabs{display:flex;flex-wrap:wrap;gap:2px;background:#efeee9;border-radius:8px;padding:3px}
.tabs button{border:0;background:transparent;font-size:13px;padding:5px 12px;border-radius:6px;color:var(--muted)}
.tabs button[aria-pressed=true]{background:var(--surface);color:var(--ink);font-weight:500;box-shadow:0 1px 2px #1519161a}
.tabs button span{font-size:12px;color:var(--faint);margin-left:3px;font-weight:400;font-variant-numeric:tabular-nums}
input[type=search]{font-size:14px;padding:7px 12px;border:1px solid var(--line-strong);border-radius:7px;background:var(--surface);min-width:240px}
input[type=search]:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 3px #24402f1a}
.mode a{color:var(--accent);text-decoration:underline;text-underline-offset:2px}
.day{font-size:13px;font-weight:600;color:var(--ink);margin:32px 0 0;padding-bottom:8px;border-bottom:1px solid var(--line)}
#sent-list .dm-row{border:0;border-bottom:1px solid var(--line);border-radius:0;background:transparent;margin:0;padding:14px 0}
.empty{color:var(--muted);text-align:center;padding:48px 0}
.foot{color:var(--faint);font-size:12.5px;margin-top:28px}
@media(max-width:640px){.wrap{padding:32px 20px 56px}.controls{flex-direction:column;align-items:stretch}input[type=search]{min-width:0;width:100%}}
`;

/** Row styles, shared with the dashboard's Recent DMs list. */
export const sentRowStyles = `
.dm-row{display:grid;grid-template-columns:72px minmax(0,1fr) auto;gap:16px;align-items:start;padding:14px 16px;background:var(--surface);border:1px solid var(--line);border-radius:10px}
.dm-row time{font-size:13px;color:var(--faint);padding-top:1px;font-variant-numeric:tabular-nums;white-space:nowrap}
.recent-dms .dm-row{grid-template-columns:112px minmax(0,1fr) auto}
.dm-main{min-width:0}
.dm-line{display:flex;flex-wrap:wrap;gap:2px 8px;align-items:baseline}
.who{font-weight:500;color:var(--ink);text-decoration:none}a.who:hover{text-decoration:underline;text-underline-offset:2px}
.why{color:var(--muted);font-size:13.5px}
.keyword{font-family:var(--mono);font-size:11.5px;letter-spacing:.02em;color:var(--muted)}
.partial{font-size:12px;color:var(--warn);background:var(--warn-soft);border-radius:5px;padding:0 7px}
.said{margin:3px 0 0;color:var(--text);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.note{margin:6px 0 0;font-size:12.5px;color:var(--warn);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sent{font-size:13px;color:var(--accent);white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis;padding-top:1px}
.sent.failed{color:var(--danger)}
.fresh{animation:fresh 2.4s ease-out}@keyframes fresh{from{background:#eef4dc}}
@media(max-width:640px){.dm-row,.recent-dms .dm-row{grid-template-columns:minmax(0,1fr);gap:4px}.sent{max-width:100%}}
`;
