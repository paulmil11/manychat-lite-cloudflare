import {
  buildReplyLink,
  MAX_CUSTOM_REPLIES,
  MAX_STARTERS,
  MAX_STORY_RULES,
  parseReplyRef,
  type CustomReply,
  type DmFeatureSettings,
  type IceBreakersPublicationStatus,
  type StoryRule
} from "./dm-features";

// A reply that a starter, story rule or DM link can point at.
export type ReplyOption = { key: string; label: string; group: "rule" | "text"; detail: string };

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function replyOptions(options: ReplyOption[], selected: string): string {
  const groups: Array<[ReplyOption["group"], string]> = [["rule", "Keyword automations"], ["text", "Custom replies"]];
  const missing = selected && !options.some((option) => option.key === selected)
    ? `<option value="${esc(selected)}" selected>Removed reply (choose another)</option>` : "";
  const body = groups.map(([group, label]) => {
    const items = options.filter((option) => option.group === group);
    return items.length
      ? `<optgroup label="${label}">${items.map((option) => `<option value="${esc(option.key)}" ${option.key === selected ? "selected" : ""}>${esc(option.label)}${option.detail ? ` · ${esc(option.detail)}` : ""}</option>`).join("")}</optgroup>`
      : "";
  }).join("");
  return missing + (body || '<option value="">Add an automation or custom reply first</option>');
}

function displayTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return esc(value);
  return `<time datetime="${esc(date.toISOString())}">${esc(date.toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC"
  }))} UTC</time>`;
}

function publication(status: IceBreakersPublicationStatus, enabled: boolean): string {
  const label = status.state === "synced"
    ? enabled ? "Live on Instagram" : "Removed from Instagram"
    : status.state === "pending" ? "Instagram has an older version"
      : status.state === "error" ? "Publishing failed" : "Not on Instagram yet";
  return `<div class="dm-publish-status"><span class="tag ${status.state === "synced" ? "ok" : status.state === "error" ? "danger" : "warn"}">${label}</span>
    ${status.syncedAt ? `<span class="field-help">Last published ${displayTime(status.syncedAt)}</span>` : ""}
    ${status.error ? `<p class="dm-publish-error" role="status">${esc(status.error)}</p>` : ""}</div>`;
}

function publishHelp(status: IceBreakersPublicationStatus, dryRun: boolean): string {
  if (dryRun) return "Publishing is off in test mode.";
  return status.state === "pending"
    ? "Your saved starters changed after the last publish. Publish to update what people see in Instagram."
    : "Publishing updates the buttons people see when they open a new chat with you.";
}

/** The DM tools part of Settings: one two-column row per tool. */
export function renderDmFeaturesPanel(data: {
  settings: DmFeatureSettings;
  publication: IceBreakersPublicationStatus;
  options: ReplyOption[];
  username: string | null;
  dryRun: boolean;
}): string {
  const { settings, options } = data;
  const normalizedUsername = (data.username ?? "").trim().replace(/^@/, "");
  const canBuildLinks = /^[A-Za-z0-9._]{1,30}$/.test(normalizedUsername);
  const defaultReply = options[0]?.key ?? "";
  return `<section class="dm-tools" id="dm-tools" aria-label="DM tools">
    <form action="/admin/dm-features" method="post" id="dm-feature-settings" class="dm-settings-form">
      <div class="setting dm-feature">
        <div class="setting-intro"><h3 id="dm-starters-title">Conversation starters</h3><p>Up to ${MAX_STARTERS} buttons people see when they open a new chat with you. Each one sends an automation’s DM or a custom reply.</p></div>
        <div class="setting-body">
          <label class="switch-label"><input type="checkbox" name="starters_enabled" ${settings.startersEnabled ? "checked" : ""}><span class="switch"></span>Show conversation starters</label>
          <div class="dm-starter-list">${Array.from({ length: MAX_STARTERS }, (_, index) => {
            const starter = settings.starters[index];
            return `<div class="dm-starter-row"><span class="dm-row-number" aria-hidden="true">${index + 1}</span><label>Button ${index + 1}<input name="starter_title" value="${esc(starter?.title ?? "")}" maxlength="80" placeholder="Leave blank to skip"></label><label>Reply<select name="starter_reply">${replyOptions(options, starter?.reply ?? defaultReply)}</select></label></div>`;
          }).join("")}</div>
          <p class="field-help">Saving keeps your starters on this dashboard. Publishing, below, sends them to Instagram.</p>
        </div>
      </div>
      <div class="setting dm-feature">
        <div class="setting-intro"><h3 id="dm-followers-title">Follower status</h3><p>Open with a different line for followers and for people who don’t follow you. Only checks people who message you or tap a starter.</p></div>
        <div class="setting-body">
          <label class="switch-label"><input type="checkbox" name="follower_check_enabled" ${settings.followerCheckEnabled ? "checked" : ""}><span class="switch"></span>Check follower status for incoming DMs</label>
          <div class="two-fields"><label>For followers <span class="optional">optional</span><textarea name="follower_reply" rows="2" maxlength="80" placeholder="Thanks for following!">${esc(settings.followerReply)}</textarea></label>
          <label>For people who don’t follow you <span class="optional">optional</span><textarea name="non_follower_reply" rows="2" maxlength="80" placeholder="Thanks for getting in touch!">${esc(settings.nonFollowerReply)}</textarea></label></div>
          <p class="field-help">Up to 80 characters, added before the reply when it still fits Instagram’s limit. Blank lines or unavailable follower status keep the usual message. Results are kept for up to 24 hours. This doesn’t message new followers.</p>
          <div class="form-actions dm-save-actions"><span class="field-help">Saving doesn’t send a message or publish starters.</span><button class="button primary">Save DM settings</button></div>
        </div>
      </div>
    </form>
    <div class="setting dm-publish-row">
      <div class="setting-intro"><h3>Publish starters</h3><p>Saving keeps the starters on this dashboard. Publishing sends them to Instagram, where they appear in the mobile app.</p></div>
      <div class="setting-body">${publication(data.publication, settings.startersEnabled)}<form action="/admin/dm-features/publish" method="post" id="dm-publish-form"><button class="button secondary" data-publish-starters ${data.dryRun ? "disabled" : ""}>${settings.startersEnabled ? "Publish saved starters" : "Remove starters from Instagram"}</button></form><p class="field-help" id="dm-publish-help">${publishHelp(data.publication, data.dryRun)}</p></div>
    </div>
    ${customReplies(settings.customReplies)}
    <section class="setting dm-feature dm-story-section" aria-labelledby="dm-story-title">
      <div class="setting-intro"><h3 id="dm-story-title">Story replies</h3><p>Send a reply when someone answers a specific story, a keyword in any story, or both. A specific story wins over a keyword for every story, and a paused rule blocks broader ones. These run before automations that listen for story replies.</p><p class="field-help">Use a story ID or link-sticker URL when you can. Story media links expire. ${settings.storyRules.length} of ${MAX_STORY_RULES} used.</p></div>
      <div class="setting-body">
      ${storyRules(settings.storyRules, options)}
      ${settings.storyRules.length < MAX_STORY_RULES ? `<details class="dm-add-story"><summary>Add a story rule</summary><form action="/admin/story-rules" method="post" class="stack dm-new-story-form">
        <input type="hidden" name="action" value="save"><div class="two-fields"><label>Rule name<input name="label" required maxlength="80" placeholder="Workshop story"></label><label>Reply<select name="reply">${replyOptions(options, defaultReply)}</select></label></div>
        <div class="two-fields"><label>Story ID <span class="optional">optional</span><input name="story_id" maxlength="40" inputmode="numeric" pattern="[0-9]*" placeholder="From Activity"></label><label>Keyword <span class="optional">optional</span><input name="keyword" maxlength="80" placeholder="WORKSHOP"></label></div>
        <label>Story or link-sticker URL <span class="optional">optional</span><input name="story_url" type="url" maxlength="2000" placeholder="https://…"></label>
        <p class="field-help">Add at least a story ID, a URL, or a keyword.</p><div class="form-actions"><label class="switch-label"><input type="checkbox" name="enabled" checked><span class="switch"></span>On</label><button class="button primary">Add story rule</button></div>
      </form></details>` : ""}
      </div>
    </section>
    <section class="setting dm-feature dm-flow-links" aria-labelledby="dm-links-title" data-dm-link-username="${esc(canBuildLinks ? normalizedUsername : "")}">
      <div class="setting-intro"><h3 id="dm-links-title">Links to your DMs</h3><p>Links that open a chat with a specific reply. Add a source to see where people came from.</p>${canBuildLinks ? `<p class="field-help">@${esc(normalizedUsername)}</p>` : ""}</div>
      <div class="setting-body">
      <label class="dm-link-source">Source <span class="optional">optional</span><input id="dm-link-source" value="website" maxlength="80" pattern="[A-Za-z0-9_\\-]{1,80}" placeholder="website" aria-describedby="dm-link-source-help"><span class="field-help" id="dm-link-source-help">Letters, numbers, hyphens and underscores, like website or newsletter.</span></label>
      ${canBuildLinks
        ? options.length
          ? `<div class="dm-links-list">${options.map((option, index) => `<div class="dm-link-row"><label for="dm-link-${index}">${esc(option.label)}</label><input id="dm-link-${index}" data-reply-key="${esc(option.key)}" value="${esc(buildReplyLink(normalizedUsername, option.key, "website"))}" readonly aria-label="${esc(option.label)} DM link"><button type="button" class="button secondary" data-copy-dm-link="dm-link-${index}">Copy<span class="sr-only"> ${esc(option.label)} link</span></button></div>`).join("")}</div>`
          : '<p class="dm-empty">Add an automation or custom reply to get links.</p>'
        : '<p class="notice">Check your Instagram connection, or set OWNER_IG_USERNAME, to load links for your account.</p>'}
      <p id="dm-link-feedback" class="field-help" role="status" aria-live="polite"></p><p class="field-help">Opens Instagram on mobile. New chats start after a message or button tap.</p>
      </div>
    </section>
  </section>`;
}

function customReplies(replies: CustomReply[]): string {
  return `<section class="setting dm-feature dm-custom-section" aria-labelledby="dm-custom-title">
    <div class="setting-intro"><h3 id="dm-custom-title">Custom replies</h3><p>Plain text replies for starters, story rules and DM links that don’t belong to an automation.</p><p class="field-help">${replies.length} of ${MAX_CUSTOM_REPLIES} used.</p></div>
    <div class="setting-body">
    ${replies.length ? `<div class="dm-custom-list">${replies.map((reply) => `<details class="dm-custom"><summary><strong>${esc(reply.label)}</strong><span>${esc(reply.text.length > 140 ? `${reply.text.slice(0, 137)}…` : reply.text)}</span></summary>
      <form action="/admin/custom-replies" method="post" class="stack"><input type="hidden" name="id" value="${esc(reply.id)}"><label>Name<input name="label" value="${esc(reply.label)}" maxlength="80" required></label><label>Message<textarea name="text" rows="3" maxlength="1000" required>${esc(reply.text)}</textarea></label>
      <div class="form-actions"><span class="dm-reply-key">text-${esc(reply.id)}</span><div><button class="button danger" name="action" value="delete" formnovalidate data-confirm="Delete this custom reply?">Delete</button><button class="button primary" name="action" value="save">Save reply</button></div></div></form></details>`).join("")}</div>` : '<p class="dm-empty">No custom replies yet.</p>'}
    ${replies.length < MAX_CUSTOM_REPLIES ? `<details class="dm-add-story"><summary>Add a custom reply</summary><form action="/admin/custom-replies" method="post" class="stack dm-new-story-form">
      <input type="hidden" name="action" value="save"><label>Name<input name="label" required maxlength="80" placeholder="Ask a question"></label><label>Message<textarea name="text" rows="3" maxlength="1000" required placeholder="Send your question here and I will reply soon."></textarea></label>
      <div class="form-actions"><span class="field-help">Up to 1,000 characters.</span><button class="button primary">Add custom reply</button></div>
    </form></details>` : ""}
    </div>
  </section>`;
}

function storyRules(rules: StoryRule[], options: ReplyOption[]): string {
  if (!rules.length) return '<p class="dm-empty">No story rules yet.</p>';
  return `<div class="table-scroll"><table class="dm-story-table"><thead><tr><th>Rule</th><th>Story</th><th>Keyword</th><th>Reply</th><th>On</th><th>Actions</th></tr></thead><tbody>${rules.map((rule, index) => {
    const formId = `dm-story-rule-${index}`;
    return `<tr><td data-column="Rule"><form action="/admin/story-rules" method="post" id="${formId}"><input type="hidden" name="id" value="${esc(rule.id)}"><input name="label" value="${esc(rule.label)}" maxlength="80" required aria-label="Rule name"></form></td>
      <td data-column="Story"><div class="dm-story-target"><input name="story_id" maxlength="40" form="${formId}" value="${esc(rule.storyId)}" pattern="[0-9]*" inputmode="numeric" placeholder="Any story · add ID" aria-label="Story ID"><input name="story_url" form="${formId}" value="${esc(rule.storyUrl)}" type="url" maxlength="2000" placeholder="Story or link-sticker URL" aria-label="Story or link-sticker URL"></div></td>
      <td data-column="Keyword"><input name="keyword" form="${formId}" value="${esc(rule.keyword)}" maxlength="80" placeholder="Any reply" aria-label="Story reply keyword"></td>
      <td data-column="Reply"><select name="reply" form="${formId}" aria-label="Story response">${replyOptions(options, rule.reply)}</select></td>
      <td data-column="On"><label class="switch-label dm-table-switch"><input type="checkbox" name="enabled" form="${formId}" ${rule.enabled ? "checked" : ""}><span class="switch"></span><span class="sr-only">Turn on ${esc(rule.label)}</span></label></td>
      <td data-column="Actions"><div class="dm-story-actions"><button class="button secondary" name="action" value="save" form="${formId}">Save</button><button class="button danger" name="action" value="delete" form="${formId}" formnovalidate data-confirm="Delete this story rule?">Delete</button></div></td></tr>`;
  }).join("")}</tbody></table></div>`;
}

export type DmMessageContext = {
  source?: string | null;
  referral_ref?: string | null;
  story_id?: string | null;
  story_url?: string | null;
  story_link_url?: string | null;
  is_follower?: number | null;
  profile_error?: string | null;
  profile_checked_at?: string | null;
};

const SOURCE_NAMES: Record<string, string> = {
  dm: "Direct message",
  starter: "Conversation starter",
  story_reply: "Story reply",
  story_mention: "Story mention",
  referral: "DM link",
  postback: "Button tap"
};

/** Where an incoming DM came from, shown under each DM in the activity list. */
export function renderDmMessageContext(row: DmMessageContext): string {
  const parts: string[] = [];
  if (row.source) parts.push(`<span>${esc(SOURCE_NAMES[row.source] ?? row.source.replace(/_/g, " "))}</span>`);
  if (row.referral_ref) {
    const source = parseReplyRef(row.referral_ref)?.source ?? null;
    parts.push(`<span>Link source: ${esc(source ?? row.referral_ref)}</span>`);
  }
  if (row.is_follower === 1) parts.push('<span class="dm-follower">Follows you</span>');
  else if (row.is_follower === 0) parts.push("<span>Doesn’t follow you</span>");
  else if (row.profile_checked_at || row.profile_error) parts.push("<span>Follower status unavailable</span>");
  if (row.story_id) parts.push(`<span class="dm-story-id">Story ID: ${esc(row.story_id)}</span>`);
  const link = row.story_link_url || row.story_url;
  if (link) {
    try {
      const url = new URL(link);
      if (url.protocol === "https:" && !url.username && !url.password) {
        parts.push(`<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${row.story_link_url ? "Story link sticker" : "Story media"} ↗</a>`);
      }
    } catch { /* Omit malformed activity links. */ }
  }
  return parts.length ? `<div class="dm-message-context">${parts.join("")}</div>` : "";
}

export const dmFeaturesClientScript = `
(() => {
  const form = document.getElementById('dm-feature-settings');
  const publish = document.querySelector('[data-publish-starters]');
  const publishHelp = document.getElementById('dm-publish-help');
  if (form && publish && !publish.disabled) {
    const markUnsaved = () => { publish.disabled = true; publishHelp.textContent = 'Save your changes before publishing.'; };
    form.addEventListener('input', markUnsaved);
    form.addEventListener('change', markUnsaved);
  }
  document.querySelectorAll('[data-confirm]').forEach(button => button.addEventListener('click', event => {
    if (!confirm(button.dataset.confirm)) event.preventDefault();
  }));
  const panel = document.querySelector('[data-dm-link-username]');
  if (!panel || !panel.dataset.dmLinkUsername) return;
  const source = document.getElementById('dm-link-source');
  const feedback = document.getElementById('dm-link-feedback');
  const linkInputs = [...panel.querySelectorAll('[data-reply-key]')];
  const copyButtons = [...panel.querySelectorAll('[data-copy-dm-link]')];
  source.addEventListener('input', () => {
    const value = source.value.trim() || 'website';
    const valid = /^[A-Za-z0-9_-]{1,80}$/.test(value);
    source.setAttribute('aria-invalid', String(!valid));
    feedback.textContent = valid ? '' : 'Use letters, numbers, hyphens, or underscores for the source.';
    copyButtons.forEach(button => { button.disabled = !valid; });
    linkInputs.forEach(input => {
      input.value = valid ? 'https://ig.me/' + encodeURIComponent(panel.dataset.dmLinkUsername) + '?ref=' + input.dataset.replyKey + '__' + value : '';
    });
  });
  copyButtons.forEach(button => button.addEventListener('click', async () => {
    const input = document.getElementById(button.dataset.copyDmLink);
    if (!input || !input.value) return;
    try { await navigator.clipboard.writeText(input.value); feedback.textContent = 'Link copied.'; }
    catch { input.focus(); input.select(); feedback.textContent = 'Link selected. Copy it with your keyboard.'; }
  }));
})();
`;

export const dmFeaturesStyles = `
.dm-settings-form{margin:0}
.dm-starter-list{display:flex;flex-direction:column;gap:10px}
.dm-starter-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,.9fr);gap:10px;align-items:end}
.dm-row-number{display:none}
.dm-save-actions{padding-top:4px}
.dm-publish-status{display:flex;align-items:center;flex-wrap:wrap;gap:10px}
.dm-publish-error{flex-basis:100%;font-size:12.5px;color:var(--danger);overflow-wrap:anywhere}
#dm-publish-form{margin:0}
.dm-tools button:disabled{opacity:.45;cursor:not-allowed}
.dm-story-table{min-width:760px}
.dm-story-table th{padding-right:10px}
.dm-story-table td{padding:10px 10px 10px 0;white-space:normal}
.dm-story-table input,.dm-story-table select{font-size:13px;padding:6px 8px}
.dm-story-table select{padding-right:26px}
.dm-story-target{display:grid;gap:6px}
.dm-story-actions{display:flex;gap:4px}
.dm-story-actions .button{height:30px;padding:0 10px;font-size:12.5px}
.dm-table-switch{height:30px}
.dm-empty{color:var(--muted);font-size:13px}
.dm-add-story{border:1px solid var(--line);border-radius:10px;background:var(--surface)}
.dm-add-story>summary{cursor:pointer;padding:10px 14px;font-size:13px;font-weight:500;color:var(--accent);list-style:none}
.dm-add-story>summary::-webkit-details-marker{display:none}
.dm-add-story>summary:before{content:"+";display:inline-block;width:14px;color:var(--faint)}
.dm-add-story[open]>summary{border-bottom:1px solid var(--line)}
.dm-new-story-form{padding:16px 14px}
.dm-custom-list{display:flex;flex-direction:column;border-top:1px solid var(--line)}
.dm-custom{border-bottom:1px solid var(--line)}
.dm-custom>summary{display:flex;flex-direction:column;gap:2px;padding:10px 0;cursor:pointer;list-style:none}
.dm-custom>summary::-webkit-details-marker{display:none}
.dm-custom>summary strong{font-weight:500;color:var(--ink)}
.dm-custom>summary span{font-size:13px;color:var(--muted);overflow-wrap:anywhere}
.dm-custom>form{padding:4px 0 18px}
.dm-reply-key{font-family:var(--mono);font-size:12px;color:var(--faint)}
.dm-links-list{display:flex;flex-direction:column;gap:8px}
.dm-link-row{display:grid;grid-template-columns:130px minmax(0,1fr) auto;gap:10px;align-items:center}
.dm-link-row>label{font-weight:400;color:var(--muted);overflow-wrap:anywhere}
.dm-link-row input{font-family:var(--mono);font-size:12.5px}
.dm-link-source{max-width:320px}
.dm-message-context{display:flex;flex-wrap:wrap;gap:2px 12px;margin-top:2px;font-size:12.5px;color:var(--faint)}
.dm-message-context a{color:var(--muted);text-decoration:underline;text-underline-offset:2px}
.dm-message-context .dm-follower{color:var(--accent)}
.dm-message-context .dm-story-id{overflow-wrap:anywhere}
@media(max-width:760px){.dm-starter-row{grid-template-columns:minmax(0,1fr) 130px;gap:8px}.dm-story-table{min-width:0}.dm-story-table thead{display:none}.dm-story-table,.dm-story-table tbody{display:block;width:100%}.dm-story-table tr{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:14px 0;border-bottom:1px solid var(--line)}.dm-story-table td{display:block;padding:0;border:0;min-width:0}.dm-story-table td:before{content:attr(data-column);display:block;font-size:12px;color:var(--faint);margin-bottom:4px}.dm-story-table td:first-child,.dm-story-table td:nth-child(2){grid-column:1/-1}.dm-story-target{grid-template-columns:1fr 1fr}.dm-link-row{grid-template-columns:minmax(0,1fr) auto;gap:6px}.dm-link-row>label{grid-column:1/-1}}
@media(max-width:420px){.dm-story-target{grid-template-columns:1fr}.dm-save-actions .button{width:100%}}
`;
