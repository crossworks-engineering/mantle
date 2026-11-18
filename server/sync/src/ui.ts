/**
 * The Sync sidecar's own screens (Sync service plan M2, decision 3): plain
 * HTML forms, no script. The client shows them in a sandboxed frame through
 * the brain's one generic route (/api/services/sync/ui?p=<path>&t=<ticket>), which
 * checks the frame ticket and hands each request here with the token, the
 * base path and a fresh ticket for the links and forms of the answer.
 *
 * Screens: the list of mailboxes and feeds with their status; add or edit a
 * mailbox (checked by a login on save); its folders; add or edit a feed;
 * remove (with a confirm step); "Sync now"; discover (recent senders who are
 * no contact yet, with "Add as contact").
 */
import { errorMessage, isUuid } from '@mantle/std';
import {
  AccountError,
  DAYS_MAX,
  refreshDrives,
  removeAccount,
  saveFeed as saveAccountFeed,
  saveMailbox as saveAccountMailbox,
  setDrive,
  setOutlookMail,
  type AccountDeps,
} from './accounts';
import { allFolders, connect } from './imap';
import { discover, runError } from './mail';
import { appView, browseDrive, GraphError, MsAuthError, saveApp } from './microsoft';
import type { MailAccount } from './state';

export type UiRequest = {
  method: string;
  /** The path below /ui, e.g. `/mailbox/new`. */
  path: string;
  /** The form fields of a POST. */
  form: URLSearchParams;
  /** Where the brain serves these screens, e.g. `/api/services/sync/ui`. */
  base: string;
  /** The frame ticket the answer's links and forms carry. */
  ticket: string;
  /** The brain's public origin (`https://brain.example`), for the redirect
   *  URI a Microsoft app registers. Empty when the brain sent none. */
  origin?: string;
};

export type UiDeps = AccountDeps;

export type UiReply = { status: number; html: string };

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A screen's address through the brain: the one route, the screen's path
 *  in `p`, the ticket in `t`. */
function href(req: UiRequest, path: string): string {
  return `${req.base}?p=${encodeURIComponent(path)}&t=${encodeURIComponent(req.ticket)}`;
}

const STYLE = `
:root{color-scheme:light dark;--fg:#1f2328;--muted:#656d76;--bg:#fff;--line:#d0d7de;--accent:#0969da;--bad:#cf222e;--good:#1a7f37;--card:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#8d96a0;--bg:#0d1117;--line:#30363d;--accent:#4493f8;--bad:#f85149;--good:#3fb950;--card:#161b22}}
*{box-sizing:border-box}body{margin:0;padding:16px;font:14px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg)}
h1{font-size:18px;margin:0 0 12px}h2{font-size:15px;margin:20px 0 8px}
a{color:var(--accent)}p.muted,span.muted{color:var(--muted)}
.card{border:1px solid var(--line);border-radius:8px;padding:12px;margin:8px 0;background:var(--card)}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}
.actions{display:flex;flex-wrap:wrap;gap:6px}
form.inline{display:inline}
button,.btn{font:inherit;padding:5px 12px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer;text-decoration:none;display:inline-block}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.danger{color:var(--bad)}
label{display:block;margin:10px 0 4px;font-weight:600}
input[type=text],input[type=email],input[type=password],input[type=number],input[type=url]{width:100%;max-width:420px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
.check{font-weight:400}
.ok{color:var(--good)}.bad{color:var(--bad)}
.notice{border-left:3px solid var(--good);padding:6px 10px;margin:8px 0}
.error{border-left:3px solid var(--bad);padding:6px 10px;margin:8px 0}
fieldset{border:1px solid var(--line);border-radius:8px;margin:12px 0;padding:8px 12px;max-width:460px}
legend{font-weight:600}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

function postButton(req: UiRequest, path: string, label: string, cls = ''): string {
  return `<form class="inline" method="post" action="${esc(href(req, path))}"><button type="submit"${cls ? ` class="${cls}"` : ''}>${esc(label)}</button></form>`;
}

function statusLine(
  s: { at: string; ok: boolean; error?: string; count?: number } | null,
  unit: string,
): string {
  if (!s) return '<span class="muted">Not run yet.</span>';
  const at = esc(new Date(s.at).toISOString().replace('T', ' ').slice(0, 16));
  return s.ok
    ? `<span class="ok">Last run ${at} UTC</span>${s.count !== undefined ? ` <span class="muted">(${esc(s.count)} ${unit})</span>` : ''}`
    : `<span class="bad">Failed ${at} UTC: ${esc(s.error ?? 'error')}</span>`;
}

async function listScreen(req: UiRequest, deps: UiDeps, notice?: string): Promise<UiReply> {
  const [accounts, feeds, msAccounts, drives, app] = await Promise.all([
    deps.state.accounts(),
    deps.state.feeds(),
    deps.state.msAccounts(),
    deps.state.msDrives(),
    deps.state.msApp(),
  ]);
  const statuses = new Map(
    await Promise.all(
      [
        ...accounts.map((a) => a.id),
        ...feeds.map((f) => f.id),
        ...drives.map((d) => d.id),
        ...msAccounts.flatMap((a) => (a.mailboxId ? [a.mailboxId] : [])),
      ].map(async (id) => [id, await deps.state.status(id)] as const),
    ),
  );
  const mailboxes = accounts.length
    ? accounts
        .map(
          (a) =>
            `<div class="card"><div class="row"><div><strong>${esc(a.address)}</strong>${
              a.enabled ? '' : ' <span class="muted">(off)</span>'
            }${a.smtp ? '' : ' <span class="muted">(does not send)</span>'}<br>${statusLine(statuses.get(a.id) ?? null, 'stored')}</div><div class="actions">${postButton(
              req,
              `/mailbox/${a.id}/run`,
              'Sync now',
            )}<a class="btn" href="${esc(href(req, `/mailbox/${a.id}`))}">Edit</a><a class="btn" href="${esc(
              href(req, `/mailbox/${a.id}/folders`),
            )}">Folders</a><a class="btn" href="${esc(href(req, `/mailbox/${a.id}/remove`))}">Remove</a></div></div></div>`,
        )
        .join('')
    : '<p class="muted">No mailbox linked yet.</p>';
  const feedList = feeds.length
    ? feeds
        .map(
          (f) =>
            `<div class="card"><div class="row"><div><strong>${esc(f.name)}</strong>${
              f.enabled ? '' : ' <span class="muted">(off)</span>'
            }<br>${statusLine(statuses.get(f.id) ?? null, 'events')}</div><div class="actions">${postButton(
              req,
              `/feed/${f.id}/run`,
              'Sync now',
            )}<a class="btn" href="${esc(href(req, `/feed/${f.id}`))}">Edit</a><a class="btn" href="${esc(
              href(req, `/feed/${f.id}/remove`),
            )}">Remove</a></div></div></div>`,
        )
        .join('')
    : '<p class="muted">No calendar feed yet.</p>';
  const connect = `${req.base.replace(/\/ui$/, '/oauth/start')}?t=${encodeURIComponent(req.ticket)}`;
  const msList = msAccounts
    .map((a) => {
      const mine = drives.filter((d) => d.accountId === a.id);
      const driveRows = mine.length
        ? mine
            .map(
              (d) =>
                `<div class="card"><div class="row"><div><strong>${esc(d.siteName ? `${d.siteName}: ${d.name}` : d.name)}</strong>${
                  d.enabled ? '' : ' <span class="muted">(off)</span>'
                }${d.selections.length ? ` <span class="muted">(${esc(d.selections.length)} chosen)</span>` : ''}<br>${
                  d.enabled ? statusLine(statuses.get(d.id) ?? null, 'files') : ''
                }</div><div class="actions">${postButton(req, `/drive/${d.id}/${d.enabled ? 'off' : 'on'}`, d.enabled ? 'Turn off' : 'Turn on')}${
                  d.enabled ? postButton(req, `/drive/${d.id}/run`, 'Sync now') : ''
                }<a class="btn" href="${esc(href(req, `/drive/${d.id}/browse`))}">Choose folders</a></div></div></div>`,
            )
            .join('')
        : '<p class="muted">No drive found yet.</p>';
      return `<div class="card"><div class="row"><div><strong>${esc(a.upn)}</strong>${
        a.lastError
          ? `<br><span class="bad">${esc(a.lastError)}</span> <a href="${esc(connect)}" target="_blank" rel="noopener">Connect again</a>`
          : ''
      }<br>Outlook mail: ${a.mail ? `on. ${statusLine(a.mailboxId ? (statuses.get(a.mailboxId) ?? null) : null, 'stored')}` : '<span class="muted">off</span>'}</div><div class="actions">${postButton(
        req,
        `/microsoft/${a.id}/${a.mail ? 'mail-off' : 'mail-on'}`,
        a.mail ? 'Mail off' : 'Mail on',
      )}${postButton(req, `/microsoft/${a.id}/drives`, 'Find drives')}<a class="btn" href="${esc(href(req, `/microsoft/${a.id}/remove`))}">Disconnect</a></div></div>${driveRows}</div>`;
    })
    .join('');
  const microsoft = app
    ? `${msList || '<p class="muted">No Microsoft account connected yet.</p>'}<p><a class="btn" href="${esc(connect)}" target="_blank" rel="noopener">Connect a Microsoft account</a> <a class="btn" href="${esc(href(req, '/microsoft/app'))}">Microsoft app</a></p><p class="muted">Connect opens Microsoft's sign-in in a new tab. When it says connected, come back and press Reload.</p>`
    : `<p class="muted">Set the Microsoft app (an Azure app registration) first.</p><p><a class="btn" href="${esc(href(req, '/microsoft/app'))}">Set the Microsoft app</a></p>`;
  return {
    status: 200,
    html: page(
      'Accounts',
      `<h1>Accounts</h1>${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
<p class="muted">Only mail from your contacts is kept. Mail syncs every 5 minutes, feeds every 30 minutes.</p>
<h2>Mailboxes</h2>${mailboxes}<p><a class="btn" href="${esc(href(req, '/mailbox/new'))}">Add a mailbox</a> <a class="btn" href="${esc(href(req, '/discover'))}">Find senders to add as contacts</a></p>
<h2>Calendar feeds</h2>${feedList}<p><a class="btn" href="${esc(href(req, '/feed/new'))}">Add a calendar feed</a></p>
<h2>Microsoft 365</h2><p class="muted">OneDrive and SharePoint files sync every 5 minutes into the brain as normal files; Outlook mail from your contacts every 5 minutes. A drive syncs only once you turn it on.</p>${microsoft}`,
    ),
  };
}

type MailboxFields = {
  address: string;
  displayName: string;
  imapHost: string;
  imapPort: string;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  firstScanDays: string;
  enabled: boolean;
};

function fieldsOf(a: MailAccount | null): MailboxFields {
  return {
    address: a?.address ?? '',
    displayName: a?.displayName ?? '',
    imapHost: a?.imap.host ?? '',
    imapPort: String(a?.imap.port ?? 993),
    imapSecure: a?.imap.secure ?? true,
    smtpHost: a?.smtp?.host ?? '',
    smtpPort: String(a?.smtp?.port ?? 465),
    smtpSecure: a?.smtp?.secure ?? true,
    firstScanDays: String(a?.firstScanDays ?? 365),
    enabled: a?.enabled ?? true,
  };
}

function formFields(form: URLSearchParams): MailboxFields {
  const v = (k: string) => (form.get(k) ?? '').trim();
  return {
    address: v('address').toLowerCase(),
    displayName: v('displayName'),
    imapHost: v('imapHost'),
    imapPort: v('imapPort'),
    imapSecure: form.get('imapSecure') === 'on',
    smtpHost: v('smtpHost'),
    smtpPort: v('smtpPort'),
    smtpSecure: form.get('smtpSecure') === 'on',
    firstScanDays: v('firstScanDays'),
    enabled: form.get('enabled') === 'on',
  };
}

function mailboxForm(req: UiRequest, id: string | null, f: MailboxFields, error?: string): UiReply {
  const isNew = id === null;
  const input = (name: keyof MailboxFields, label: string, type = 'text', extra = '') =>
    `<label for="${name}">${esc(label)}</label><input id="${name}" name="${name}" type="${type}" value="${esc(f[name])}"${extra}>`;
  const check = (name: keyof MailboxFields, label: string) =>
    `<label class="check"><input type="checkbox" name="${name}"${f[name] ? ' checked' : ''}> ${esc(label)}</label>`;
  return {
    status: error ? 400 : 200,
    html: page(
      isNew ? 'Add a mailbox' : 'Edit a mailbox',
      `<h1>${isNew ? 'Add a mailbox' : 'Edit a mailbox'}</h1>${error ? `<div class="error">${esc(error)}</div>` : ''}
<p class="muted">Use an app password from your mail provider, not your account password. Common servers: Gmail imap.gmail.com and smtp.gmail.com; Outlook.com outlook.office365.com and smtp.office365.com (SMTP port 587); iCloud imap.mail.me.com and smtp.mail.me.com (SMTP port 587). For port 587 untick TLS: the connection then upgrades with STARTTLS, which is required.</p>
<form method="post" action="${esc(href(req, isNew ? '/mailbox/save' : `/mailbox/${id}/save`))}">
${input('address', 'Email address', 'email', isNew ? ' required' : ' readonly')}
${input('displayName', 'Name shown on sent mail (optional)')}
<label for="password">App password${isNew ? '' : ' (leave empty to keep it)'}</label><input id="password" name="password" type="password" autocomplete="new-password"${isNew ? ' required' : ''}>
<fieldset><legend>Incoming (IMAP)</legend>${input('imapHost', 'Server', 'text', ' required')}${input('imapPort', 'Port', 'number', ' min="1" max="65535" required')}${check('imapSecure', 'TLS (port 993)')}</fieldset>
<fieldset><legend>Sending (SMTP, optional)</legend><p class="muted">Leave the server empty and this mailbox does not send.</p>${input('smtpHost', 'Server')}${input('smtpPort', 'Port', 'number', ' min="1" max="65535"')}${check('smtpSecure', 'TLS from the start (port 465); off: STARTTLS on port 587')}</fieldset>
${input('firstScanDays', 'First scan reaches back (days)', 'number', ` min="1" max="${DAYS_MAX}"`)}
${check('enabled', 'Sync this mailbox')}
<p><button class="primary" type="submit">Check and save</button> <a class="btn" href="${esc(href(req, '/'))}">Cancel</a></p>
</form>`,
    ),
  };
}

async function saveMailbox(req: UiRequest, deps: UiDeps, id: string | null): Promise<UiReply> {
  const existing = id ? await deps.state.account(id) : null;
  if (id && !existing) return notFound(req);
  const f = formFields(req.form);
  if (existing) f.address = existing.address;
  try {
    const account = await saveAccountMailbox(deps, id, {
      address: f.address,
      displayName: f.displayName,
      password: req.form.get('password') ?? '',
      imapHost: f.imapHost,
      imapPort: f.imapPort,
      imapSecure: f.imapSecure,
      smtpHost: f.smtpHost,
      smtpPort: f.smtpPort,
      smtpSecure: f.smtpSecure,
      firstScanDays: f.firstScanDays,
      enabled: f.enabled,
    });
    return listScreen(req, deps, `Saved ${account.address}. The first sync starts now.`);
  } catch (err) {
    if (err instanceof AccountError) return mailboxForm(req, id, f, err.message);
    throw err;
  }
}

async function foldersScreen(
  req: UiRequest,
  deps: UiDeps,
  id: string,
  notice?: string,
): Promise<UiReply> {
  const account = await deps.state.account(id);
  if (!account) return notFound(req);
  let folders: string[];
  try {
    const client = await connect(account);
    try {
      folders = await allFolders(client);
    } finally {
      await client.logout().catch(() => {});
    }
  } catch (err) {
    return listScreen(
      req,
      deps,
      `Could not read the folders of ${account.address}: ${runError(err, account)}`,
    );
  }
  const included = new Set(account.includedFolders ?? []);
  const excluded = new Set(account.excludedFolders);
  const all = included.size === 0;
  const rows = folders
    .map((p) => {
      const on = all ? !excluded.has(p) : included.has(p);
      return `<label class="check"><input type="checkbox" name="folder" value="${esc(p)}"${on ? ' checked' : ''}> ${esc(p)}</label>`;
    })
    .join('');
  return {
    status: 200,
    html: page(
      'Folders',
      `<h1>Folders of ${esc(account.address)}</h1>${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
<p class="muted">Ticked folders sync. A folder you untick keeps the mail already stored.</p>
<form method="post" action="${esc(href(req, `/mailbox/${id}/folders`))}">${rows}
<p><button class="primary" type="submit">Save</button> <a class="btn" href="${esc(href(req, '/'))}">Back</a></p></form>`,
    ),
  };
}

async function saveFolders(req: UiRequest, deps: UiDeps, id: string): Promise<UiReply> {
  const account = await deps.state.account(id);
  if (!account) return notFound(req);
  const chosen = req.form
    .getAll('folder')
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 500);
  await deps.state.putAccount({ ...account, includedFolders: chosen.length > 0 ? chosen : null });
  return foldersScreen(
    req,
    deps,
    id,
    chosen.length > 0 ? 'Saved.' : 'Saved: every folder but the excluded ones syncs.',
  );
}

function confirmScreen(req: UiRequest, title: string, text: string, action: string): UiReply {
  return {
    status: 200,
    html: page(
      title,
      `<h1>${esc(title)}</h1><p>${esc(text)}</p><p>${postButton(req, action, 'Remove', 'danger')} <a class="btn" href="${esc(href(req, '/'))}">Cancel</a></p>`,
    ),
  };
}

async function removeOne(req: UiRequest, deps: UiDeps, id: string): Promise<UiReply> {
  let r;
  try {
    r = await removeAccount(deps, id);
  } catch (err) {
    if (err instanceof AccountError) return notFound(req);
    throw err;
  }
  const keeps =
    r.what === 'mailbox'
      ? 'Its stored mail stays in the brain.'
      : r.what === 'feed'
        ? 'Its events leave the calendar.'
        : 'Its synced files and stored mail stay in the brain.';
  return listScreen(
    req,
    deps,
    r.done
      ? `Removed ${r.name}. ${keeps}`
      : `Removing ${r.name}: it finishes after the sync under way. ${keeps}`,
  );
}

function feedForm(
  req: UiRequest,
  id: string | null,
  f: { name: string; url: string; enabled: boolean },
  error?: string,
): UiReply {
  const isNew = id === null;
  return {
    status: error ? 400 : 200,
    html: page(
      isNew ? 'Add a calendar feed' : 'Edit a calendar feed',
      `<h1>${isNew ? 'Add a calendar feed' : 'Edit a calendar feed'}</h1>${error ? `<div class="error">${esc(error)}</div>` : ''}
<p class="muted">Paste the calendar's iCal address (https or webcal). Google: Settings, the calendar, "Secret address in iCal format". Outlook: Settings, Shared calendars, Publish, ICS.</p>
<form method="post" action="${esc(href(req, isNew ? '/feed/save' : `/feed/${id}/save`))}">
<label for="name">Name</label><input id="name" name="name" type="text" maxlength="200" value="${esc(f.name)}" required>
<label for="url">iCal address${isNew ? '' : ' (leave empty to keep it)'}</label><input id="url" name="url" type="url" autocomplete="off"${isNew ? ' required' : ''}>
<label class="check"><input type="checkbox" name="enabled"${f.enabled ? ' checked' : ''}> Sync this feed</label>
<p><button class="primary" type="submit">Save</button> <a class="btn" href="${esc(href(req, '/'))}">Cancel</a></p></form>`,
    ),
  };
}

async function saveFeed(req: UiRequest, deps: UiDeps, id: string | null): Promise<UiReply> {
  const existing = id ? await deps.state.feed(id) : null;
  if (id && !existing) return notFound(req);
  const name = (req.form.get('name') ?? '').trim().slice(0, 200);
  const enabled = req.form.get('enabled') === 'on';
  try {
    const feed = await saveAccountFeed(deps, id, { name, url: req.form.get('url'), enabled });
    return listScreen(req, deps, `Saved ${feed.name}. Its first sync starts now.`);
  } catch (err) {
    if (err instanceof AccountError)
      return feedForm(req, id, { name, url: '', enabled }, err.message);
    throw err;
  }
}

async function discoverScreen(req: UiRequest, deps: UiDeps, notice?: string): Promise<UiReply> {
  let rows: string;
  try {
    const senders = await discover(deps.brain, deps.state);
    rows = senders.length
      ? senders
          .map(
            (s) =>
              `<div class="card"><div class="row"><div><strong>${esc(s.fromName ?? s.fromAddr)}</strong> <span class="muted">${esc(s.fromAddr)}</span><br><span class="muted">${esc(s.count)} in the last 30 days. Last: ${esc(s.subject ?? '(no subject)')}</span></div><form class="inline" method="post" action="${esc(href(req, '/discover/add'))}"><input type="hidden" name="address" value="${esc(s.fromAddr)}"><input type="hidden" name="name" value="${esc(s.fromName ?? '')}"><button type="submit">Add as contact</button></form></div></div>`,
          )
          .join('')
      : '<p class="muted">Every recent sender is a contact already, or no mailbox is linked.</p>';
  } catch (err) {
    rows = `<div class="error">Could not read the mailboxes: ${esc(runError(err))}</div>`;
  }
  return {
    status: 200,
    html: page(
      'Find senders',
      `<h1>Recent senders who are no contact yet</h1>${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
<p class="muted">Mail is kept only from contacts. Add a sender and the last 90 days of their mail comes in.</p>${rows}<p><a class="btn" href="${esc(href(req, '/'))}">Back</a></p>`,
    ),
  };
}

async function addSender(req: UiRequest, deps: UiDeps): Promise<UiReply> {
  const address = (req.form.get('address') ?? '').trim().toLowerCase();
  const name = (req.form.get('name') ?? '').trim().slice(0, 200);
  if (!/^[^@\s]+@[^@\s]+$/.test(address)) return discoverScreen(req, deps, 'That is no address.');
  try {
    await deps.brain.post('/api/sidecar/contacts', { address, ...(name ? { name } : {}) });
  } catch (err) {
    return discoverScreen(req, deps, `Could not add ${address}: ${errorMessage(err)}`);
  }
  return discoverScreen(req, deps, `Added ${address}. Their recent mail comes in now.`);
}

// ── Microsoft 365 (Sync service plan M3) ───────────────────────────────────

type AppFields = { clientId: string; tenant: string; redirectUri: string };

async function appForm(
  req: UiRequest,
  deps: UiDeps,
  fields?: AppFields,
  error?: string,
): Promise<UiReply> {
  const view = appView(await deps.state.msApp());
  const suggested = req.origin ? `${req.origin}/api/microsoft/oauth/callback` : '';
  const f: AppFields = fields ?? {
    clientId: view.configured ? view.clientId : '',
    tenant: view.configured ? view.tenant : 'common',
    redirectUri: view.configured ? view.redirectUri : suggested,
  };
  return {
    status: error ? 400 : 200,
    html: page(
      'Microsoft app',
      `<h1>Microsoft app</h1>${error ? `<div class="error">${esc(error)}</div>` : ''}
<p class="muted">Register a web app in Microsoft Entra (Azure). Add this redirect URI to it exactly${suggested ? `: <code>${esc(suggested)}</code>` : ''}. Give it the delegated Graph rights Files.Read.All, Sites.Read.All, Mail.Read, Mail.Send and Calendars.Read, then make a client secret.</p>
<form method="post" action="${esc(href(req, '/microsoft/app/save'))}">
<label for="clientId">Application (client) ID</label><input id="clientId" name="clientId" type="text" value="${esc(f.clientId)}" required>
<label for="clientSecret">Client secret${view.configured ? ` (leave empty to keep ${esc(view.secretMasked)})` : ''}</label><input id="clientSecret" name="clientSecret" type="password" autocomplete="new-password"${view.configured ? '' : ' required'}>
<label for="tenant">Directory (tenant): common, organizations, or the tenant id</label><input id="tenant" name="tenant" type="text" value="${esc(f.tenant)}">
<label for="redirectUri">Redirect URI</label><input id="redirectUri" name="redirectUri" type="url" value="${esc(f.redirectUri)}" required>
<p><button class="primary" type="submit">Save</button> <a class="btn" href="${esc(href(req, '/'))}">Cancel</a></p></form>`,
    ),
  };
}

async function saveAppScreen(req: UiRequest, deps: UiDeps): Promise<UiReply> {
  const v = (k: string) => (req.form.get(k) ?? '').trim();
  const fields = { clientId: v('clientId'), tenant: v('tenant'), redirectUri: v('redirectUri') };
  try {
    await saveApp(deps.state, { ...fields, clientSecret: v('clientSecret') });
  } catch (err) {
    if (err instanceof MsAuthError) return appForm(req, deps, fields, err.message);
    throw err;
  }
  return listScreen(req, deps, 'Saved the Microsoft app. Connect an account now.');
}

/** One form value of a chosen item: what the browse screen posts back. */
const selValue = (s: { itemId: string; path: string; isFolder: boolean; name?: string }) =>
  JSON.stringify({ i: s.itemId, p: s.path, f: s.isFolder, n: s.name ?? '' });

async function browseScreen(
  req: UiRequest,
  deps: UiDeps,
  driveId: string,
  itemId?: string,
  notice?: string,
): Promise<UiReply> {
  const drive = await deps.state.msDrive(driveId);
  if (!drive) return notFound(req);
  let items;
  try {
    items = await browseDrive(deps.state, drive, itemId);
  } catch (err) {
    if (err instanceof GraphError || err instanceof MsAuthError) {
      return listScreen(req, deps, `Could not read ${drive.name}: ${err.message}`);
    }
    throw err;
  }
  const chosen = new Set(drive.selections.map((s) => s.itemId));
  const rows = items
    .filter((it) => it.path)
    .map((it) => {
      const value = selValue({
        itemId: it.itemId,
        path: it.path!,
        isFolder: it.isFolder,
        name: it.name,
      });
      return `<div class="row"><label class="check"><input type="checkbox" name="sel" value="${esc(value)}"${
        chosen.has(it.itemId) ? ' checked' : ''
      }> ${it.isFolder ? '&#128193; ' : ''}${esc(it.name)}</label><input type="hidden" name="shown" value="${esc(it.itemId)}">${
        it.isFolder
          ? `<button type="submit" name="open" value="${esc(it.itemId)}" formaction="${esc(href(req, `/drive/${driveId}/browse`))}">Open</button>`
          : ''
      }</div>`;
    })
    .join('');
  const chosenList = drive.selections.length
    ? `<p class="muted">Chosen: ${drive.selections.map((s) => esc(s.path)).join(', ')}</p>`
    : '<p class="muted">Nothing chosen: the whole drive syncs.</p>';
  return {
    status: 200,
    html: page(
      'Choose folders',
      `<h1>Choose what syncs from ${esc(drive.name)}</h1>${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
<p class="muted">Tick folders or files. Nothing ticked anywhere: the whole drive syncs. A file outside your choice leaves the brain at the next sync.</p>${chosenList}
<form method="post" action="${esc(href(req, `/drive/${driveId}/select`))}">${rows || '<p class="muted">This folder is empty.</p>'}
<p><button class="primary" type="submit">Save the choice in this folder</button> <a class="btn" href="${esc(href(req, `/drive/${driveId}/browse`))}">Top of the drive</a> <a class="btn" href="${esc(href(req, '/'))}">Back</a></p></form>`,
    ),
  };
}

async function saveSelection(req: UiRequest, deps: UiDeps, driveId: string): Promise<UiReply> {
  const drive = await deps.state.msDrive(driveId);
  if (!drive) return notFound(req);
  const shown = new Set(req.form.getAll('shown'));
  const picked = req.form.getAll('sel').flatMap((v) => {
    try {
      const o = JSON.parse(v) as { i?: unknown; p?: unknown; f?: unknown; n?: unknown };
      return typeof o.i === 'string' && typeof o.p === 'string'
        ? [
            {
              itemId: o.i,
              path: o.p,
              isFolder: o.f === true,
              name: typeof o.n === 'string' ? o.n : undefined,
            },
          ]
        : [];
    } catch {
      return [];
    }
  });
  // This folder's ticks replace its own; choices in other folders stay.
  const selections = [...drive.selections.filter((s) => !shown.has(s.itemId)), ...picked];
  try {
    await setDrive(deps, driveId, { selections });
  } catch (err) {
    if (err instanceof AccountError)
      return browseScreen(req, deps, driveId, undefined, err.message);
    throw err;
  }
  return browseScreen(req, deps, driveId, undefined, 'Saved. The next sync follows it.');
}

async function microsoftAction(
  req: UiRequest,
  deps: UiDeps,
  id: string,
  action: string | undefined,
  post: boolean,
): Promise<UiReply> {
  const account = await deps.state.msAccount(id);
  if (!account) return notFound(req);
  try {
    if (action === 'mail-on' && post) {
      await setOutlookMail(deps, id, true);
      return listScreen(
        req,
        deps,
        `Outlook mail of ${account.upn} is on. The first sync starts now.`,
      );
    }
    if (action === 'mail-off' && post) {
      await setOutlookMail(deps, id, false);
      return listScreen(req, deps, `Outlook mail of ${account.upn} is off. Stored mail stays.`);
    }
    if (action === 'drives' && post) {
      const found = await refreshDrives(deps, id);
      return listScreen(req, deps, `${found.length} drive(s) found for ${account.upn}.`);
    }
  } catch (err) {
    if (err instanceof AccountError || err instanceof MsAuthError || err instanceof GraphError) {
      return listScreen(req, deps, err.message);
    }
    throw err;
  }
  if (action === 'remove') {
    if (post) return removeOne(req, deps, id);
    return confirmScreen(
      req,
      `Disconnect ${account.upn}?`,
      'Its drives and Outlook mail stop syncing and its tokens are deleted. Every synced file and stored mail stays in the brain.',
      `/microsoft/${id}/remove`,
    );
  }
  return notFound(req);
}

async function driveAction(
  req: UiRequest,
  deps: UiDeps,
  id: string,
  action: string | undefined,
  post: boolean,
): Promise<UiReply> {
  const drive = await deps.state.msDrive(id);
  if (!drive) return notFound(req);
  if ((action === 'on' || action === 'off') && post) {
    await setDrive(deps, id, { enabled: action === 'on' });
    return listScreen(
      req,
      deps,
      action === 'on'
        ? `${drive.name} is on. Its first sync starts now.`
        : `${drive.name} is off. Its synced files stay.`,
    );
  }
  if (action === 'run' && post) {
    deps.scheduler.runNow(id);
    return listScreen(req, deps, `A sync of ${drive.name} starts now.`);
  }
  if (action === 'browse') {
    const open = post ? (req.form.get('open') ?? '').trim() : '';
    return browseScreen(req, deps, id, open || undefined);
  }
  if (action === 'select' && post) return saveSelection(req, deps, id);
  return notFound(req);
}

function notFound(req: UiRequest): UiReply {
  return {
    status: 404,
    html: page(
      'Not found',
      `<h1>Not found</h1><p><a class="btn" href="${esc(href(req, '/'))}">Back</a></p>`,
    ),
  };
}

/** The answer for one screen request. */
export async function uiReply(req: UiRequest, deps: UiDeps): Promise<UiReply> {
  const p = req.path.replace(/\/+$/, '') || '/';
  const post = req.method === 'POST';
  if (!post && req.method !== 'GET')
    return { status: 405, html: page('Not allowed', '<h1>Not allowed</h1>') };

  if (p === '/' && !post) return listScreen(req, deps);
  if (p === '/mailbox/new' && !post) return mailboxForm(req, null, fieldsOf(null));
  if (p === '/mailbox/save' && post) return saveMailbox(req, deps, null);
  if (p === '/feed/new' && !post) return feedForm(req, null, { name: '', url: '', enabled: true });
  if (p === '/feed/save' && post) return saveFeed(req, deps, null);
  if (p === '/discover' && !post) return discoverScreen(req, deps);
  if (p === '/discover/add' && post) return addSender(req, deps);
  if (p === '/microsoft/app' && !post) return appForm(req, deps);
  if (p === '/microsoft/app/save' && post) return saveAppScreen(req, deps);

  const m =
    /^\/(mailbox|feed|microsoft|drive)\/([0-9a-f-]{36})(?:\/(save|run|remove|folders|mail-on|mail-off|drives|on|off|browse|select))?$/.exec(
      p,
    );
  if (!m || !isUuid(m[2])) return notFound(req);
  const [, kind, id, action] = m as unknown as [
    string,
    'mailbox' | 'feed' | 'microsoft' | 'drive',
    string,
    string | undefined,
  ];
  if (kind === 'microsoft') return microsoftAction(req, deps, id, action, post);
  if (kind === 'drive') return driveAction(req, deps, id, action, post);

  if (kind === 'mailbox') {
    if (!action && !post) {
      const a = await deps.state.account(id);
      return a ? mailboxForm(req, id, fieldsOf(a)) : notFound(req);
    }
    if (action === 'save' && post) return saveMailbox(req, deps, id);
    if (action === 'run' && post) {
      deps.scheduler.runNow(id);
      return listScreen(req, deps, 'A sync of the mailbox starts now.');
    }
    if (action === 'folders')
      return post ? saveFolders(req, deps, id) : foldersScreen(req, deps, id);
    if (action === 'remove') {
      if (post) return removeOne(req, deps, id);
      const a = await deps.state.account(id);
      return a
        ? confirmScreen(
            req,
            `Remove ${a.address}?`,
            'The mailbox stops syncing and its password is deleted. Mail already stored stays in the brain.',
            `/mailbox/${id}/remove`,
          )
        : notFound(req);
    }
    return notFound(req);
  }
  if (!action && !post) {
    const f = await deps.state.feed(id);
    return f ? feedForm(req, id, { name: f.name, url: '', enabled: f.enabled }) : notFound(req);
  }
  if (action === 'save' && post) return saveFeed(req, deps, id);
  if (action === 'run' && post) {
    deps.scheduler.runNow(id);
    return listScreen(req, deps, 'A sync of the feed starts now.');
  }
  if (action === 'remove') {
    if (post) return removeOne(req, deps, id);
    const f = await deps.state.feed(id);
    return f
      ? confirmScreen(
          req,
          `Remove ${f.name}?`,
          'The feed stops syncing and its events leave the calendar.',
          `/feed/${id}/remove`,
        )
      : notFound(req);
  }
  return notFound(req);
}
