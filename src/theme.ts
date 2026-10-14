// Shared tokens, form styles and the header for every admin page, so the
// dashboard, Sent DMs and the login page read as one product.

export const PRODUCT_NAME = "Auto-DM";

export const baseStyles = `
:root{--bg:#fbfbf9;--surface:#fff;--ink:#151916;--text:#2b302c;--muted:#6c716b;--faint:#a0a49e;--line:#e9e8e2;--line-strong:#d6d5ce;--accent:#24402f;--accent-hover:#1a3123;--accent-soft:#eef2ec;--mark:#e4ecc8;--warn:#8a5a1f;--warn-soft:#f8efe1;--danger:#9a3a2c;--danger-soft:#f7e8e4;--sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;--serif:ui-serif,"New York","Iowan Old Style",Georgia,serif;--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;color-scheme:light}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth;scroll-padding-top:88px}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 var(--sans);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
h1,h2,h3,p,dl,dd{margin:0}
a{color:inherit;text-decoration:none}
button,input,textarea,select{font:inherit;color:inherit}
button{cursor:pointer}
code{font-family:var(--mono);font-size:.92em}
[hidden]{display:none!important}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.sr-only,.skip:not(:focus){position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.skip:focus{position:fixed;left:16px;top:12px;z-index:100;padding:8px 12px;background:var(--surface);border:1px solid var(--line-strong);border-radius:6px}
.wordmark{display:inline-flex;align-items:baseline;gap:10px;white-space:nowrap}
.wordmark-name{font-family:var(--serif);font-size:19px;letter-spacing:-.01em;color:var(--ink)}
.wordmark-product{font-size:13px;color:var(--muted);padding-left:10px;border-left:1px solid var(--line-strong)}
.mode{display:inline-flex;align-items:center;gap:7px;font-size:13px;color:var(--muted);white-space:nowrap}
.mode i{width:7px;height:7px;border-radius:50%;background:#5f8f4e;box-shadow:0 0 0 3px #5f8f4e1f;flex:none}
.mode.test i,.mode.error i{background:#c08a3e;box-shadow:0 0 0 3px #c08a3e1f}
.mode.off i{background:var(--faint);box-shadow:none}
mark{background:var(--mark);color:inherit;border-radius:3px;padding:0 2px}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*:before,*:after{transition:none!important;animation:none!important}}
`;

/** Labels, inputs, buttons and switches shared by the dashboard and the login page. */
export const formStyles = `
label{display:block;font-size:13px;font-weight:500;color:var(--ink)}
label>input:not([type=checkbox]),label>select,label>textarea{display:block;margin-top:6px}
label>.field-help{display:block;margin-top:6px}
input:not([type=checkbox]):not([type=hidden]),select,textarea{width:100%;font-size:14px;font-weight:400;color:var(--text);background:var(--surface);border:1px solid var(--line-strong);border-radius:7px;padding:8px 10px;transition:border-color .15s,box-shadow .15s}
select{appearance:none;-webkit-appearance:none;padding-right:30px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236c716b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center}
textarea{resize:vertical;line-height:1.5}
input::placeholder,textarea::placeholder{color:var(--faint)}
input:focus,select:focus,textarea:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 3px #24402f1a}
input[readonly]{background:#f6f6f2;color:var(--muted)}
input[aria-invalid=true]{border-color:var(--danger)}
.optional{font-weight:400;color:var(--faint)}
.field-help{font-size:12.5px;font-weight:400;color:var(--faint);line-height:1.5}
.stack{display:flex;flex-direction:column;gap:14px}
.two-fields{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.form-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.form-actions>div{display:flex;gap:8px;flex-wrap:wrap}
.form-actions form{margin:0}
.button{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:34px;padding:0 14px;border-radius:7px;border:1px solid transparent;font-size:13px;font-weight:500;white-space:nowrap;text-decoration:none;transition:background .15s,border-color .15s,color .15s}
.button .icon{width:14px;height:14px}
.primary{background:var(--accent);color:#fff}.primary:hover{background:var(--accent-hover)}
.secondary{background:var(--surface);border-color:var(--line-strong);color:var(--ink)}.secondary:hover{border-color:var(--faint)}
.danger{background:transparent;color:var(--danger)}.danger:hover{background:var(--danger-soft)}
.button:disabled{opacity:.45;cursor:not-allowed}
.full{width:100%}
.text-link{display:inline-flex;align-items:center;gap:6px;background:none;border:0;padding:0;font-size:13px;font-weight:500;color:var(--accent)}
.text-link:hover{text-decoration:underline;text-underline-offset:3px}
.text-link .icon{width:13px;height:13px}
.switch-label{display:inline-flex;flex-direction:row;align-items:center;gap:10px;font-size:13px;font-weight:400;color:var(--text);cursor:pointer;position:relative;width:fit-content}
.switch-label input{position:absolute;opacity:0;width:1px;height:1px;margin:0}
.switch{position:relative;flex:none;width:30px;height:18px;border-radius:9px;background:var(--line-strong);transition:background .2s}
.switch:after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px #15191633;transition:transform .2s}
.switch-label input:checked+.switch{background:var(--accent)}
.switch-label input:checked+.switch:after{transform:translateX(12px)}
.switch-label input:focus-visible+.switch{outline:2px solid var(--accent);outline-offset:2px}
.tag,.badge{display:inline-flex;align-items:center;width:fit-content;font-size:12px;font-weight:500;line-height:1.5;padding:1px 8px;border-radius:5px;background:#f0efea;color:var(--muted);white-space:nowrap}
.tag.ok,.badge.green{background:var(--accent-soft);color:var(--accent)}
.tag.warn,.badge.amber{background:var(--warn-soft);color:var(--warn)}
.tag.danger,.badge.red{background:var(--danger-soft);color:var(--danger)}
.badge i{display:none}
.notice{background:var(--warn-soft);color:var(--warn);border-radius:8px;padding:10px 14px;font-size:13px}
.notice a{text-decoration:underline;text-underline-offset:2px}
@media(max-width:640px){.two-fields{grid-template-columns:1fr}}
`;

type Page = "overview" | "sent";

/** One header for every signed-in page. On the dashboard, section links stay on the page. */
export function renderHeader(page: Page, status: string): string {
  const base = page === "overview" ? "" : "/admin";
  const link = (href: string, label: string, current = false) =>
    `<a href="${href}"${current ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<header class="site-header"><div class="header-inner">
    <a class="wordmark" href="/admin"><span class="wordmark-name">${PRODUCT_NAME}</span><span class="wordmark-product">Instagram</span></a>
    <nav class="site-nav" aria-label="Dashboard">${link(`${base}#overview`, "Overview", page === "overview")}${link("/admin/sent", "Sent DMs", page === "sent")}${link(`${base}#automations`, "Automations")}${link(`${base}#activity`, "Activity")}${link(`${base}#settings`, "Settings")}</nav>
    <div class="header-end">${status}<form action="/admin/logout" method="post"><button class="signout">Sign out</button></form></div>
  </div></header>`;
}

export const headerStyles = `
.site-header{position:sticky;top:0;z-index:20;background:#fbfbf9e8;backdrop-filter:saturate(1.4) blur(10px);-webkit-backdrop-filter:saturate(1.4) blur(10px);border-bottom:1px solid var(--line)}
.header-inner{max-width:1120px;margin:0 auto;padding:0 32px;height:60px;display:flex;align-items:center;gap:36px}
.site-nav{display:flex;gap:2px;flex:1;min-width:0}
.site-nav a{font-size:13.5px;color:var(--muted);padding:6px 10px;border-radius:6px;white-space:nowrap;transition:color .15s,background .15s}
.site-nav a:hover{color:var(--ink);background:#efeee9}
.site-nav a[aria-current]{color:var(--ink);font-weight:500}
.header-end{display:flex;align-items:center;gap:20px}
.header-end form{margin:0}
.signout{background:none;border:0;padding:0;font-size:13px;color:var(--muted)}
.signout:hover{color:var(--ink)}
@media(max-width:860px){.header-inner{height:auto;flex-wrap:wrap;gap:0;padding:12px 20px 0}.wordmark{flex:1}.site-nav{order:3;flex-basis:100%;overflow-x:auto;margin:8px -10px 0;padding-bottom:6px;scrollbar-width:none}.site-nav::-webkit-scrollbar{display:none}}
`;
