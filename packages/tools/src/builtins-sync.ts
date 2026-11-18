/**
 * The Sync service's accounts over MCP (Sync service plan M3, decision 9;
 * docs/services.md "Sync"): an admin's own agent reads and changes what the
 * account screens do (admin settings are never screen-only). Each tool calls
 * the sidecar's admin routes (/admin/*, SYNC_TOKEN) through syncAdmin, as
 * email_send does; the sidecar runs the same actions as the screens.
 *
 * `mcpOnly`: an Admin user's own client; no in-brain agent is granted them.
 * The connectors area, run whole, as the screens (Settings > Accounts).
 * Marked as needing Sync (builtins.ts): off, MCP lists none of them.
 *
 * Connecting a Microsoft account stays a person's act: it is a consent in
 * the person's own browser. No tool connects one; sync_status names where.
 */
import { env } from '@mantle/config';
import { SyncAdminError, SyncOffError, syncAdmin } from '@mantle/email';
import type { BuiltinToolDef, ToolHandlerResult } from './types';
import type { ToolPolicy } from './tool-policy';
import { CS } from './client-sourced-rule';

async function admin(path: string, body: Record<string, unknown> = {}): Promise<ToolHandlerResult> {
  try {
    return { ok: true, output: await syncAdmin<Record<string, unknown>>(path, body) };
  } catch (err) {
    if (err instanceof SyncOffError || err instanceof SyncAdminError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}

/** Every sync_* tool: the connectors area, run whole, as the screens. Each
 *  def writes its scope out (the scoreboard counts each one, admin-counts.mjs). */
type Whole = { area: 'connectors'; systemWhole: true };

function readPolicy(scope: Whole): ToolPolicy {
  return { effect: 'read', spends: 'none', scope, recipe: { step: 'forbidden' } };
}

function writePolicy(what: string, scope: Whole, idempotent = true): ToolPolicy {
  return {
    matrix: { none: 'an outside account of the Sync service is not an item' },
    effect: 'write',
    spends: 'none',
    scope,
    peerRisky: true,
    ...(idempotent ? { idempotent: true as const } : {}),
    recipe: { step: 'forbidden' },
    clientSourced: CS.always(what),
  };
}

const idProp = (what: string) => ({
  type: 'string',
  description: `${what} (its id from sync_status).`,
});

/** Where the person connects a Microsoft account (the client's screen). */
function connectWhere(): string {
  const base = (env('MANTLE_PUBLIC_URL') ?? '').trim().replace(/\/+$/, '');
  const at = base ? `${base}/settings/sync` : 'Settings > Accounts';
  return `A person connects a Microsoft account at ${at}: "Connect a Microsoft account" opens Microsoft's sign-in. An agent cannot sign in.`;
}

export const sync_status: BuiltinToolDef = {
  slug: 'sync_status',
  mcpOnly: true,
  policy: readPolicy({ area: 'connectors', systemWhole: true }),
  name: 'Sync accounts and status',
  description:
    "Every outside account the Sync service holds (Settings > Accounts): IMAP mailboxes, calendar feeds, the Microsoft app, each Microsoft account with its Outlook mail switch and its OneDrive and SharePoint drives (on or off, chosen folders), and each one's last run. No password, token or feed address is shown. Ids here are what the other sync_* tools take.",
  inputSchema: { type: 'object', properties: {} },
  handler: async (): Promise<ToolHandlerResult> => {
    const r = await admin('/admin/status');
    return r.ok ? { ok: true, output: { ...(r.output as object), connect: connectWhere() } } : r;
  },
};

export const sync_mailbox_set: BuiltinToolDef = {
  slug: 'sync_mailbox_set',
  mcpOnly: true,
  policy: writePolicy('adds or changes a linked mailbox', {
    area: 'connectors',
    systemWhole: true,
  }),
  redactInputFields: ['password'],
  name: 'Add or edit a mailbox',
  description:
    "Link an IMAP mailbox (no `id`), or change one (`id`). The Sync service logs in to IMAP, and to SMTP when `smtp_host` is set, before it saves; a failed login is refused with the server's answer. Use an app password from the mail provider. On an edit an empty `password` keeps the stored one. Only mail from contacts is kept. Port 993 with TLS for IMAP; SMTP 465 with TLS, or 587 with `smtp_tls` false (STARTTLS, required).",
  inputSchema: {
    type: 'object',
    properties: {
      id: idProp('The mailbox to change; leave out to add one'),
      address: { type: 'string', description: 'The email address (ignored on an edit).' },
      display_name: { type: 'string', description: 'The name shown on sent mail.' },
      password: { type: 'string', description: 'The app password.' },
      imap_host: { type: 'string', description: 'The IMAP server, e.g. `imap.example.com`.' },
      imap_port: { type: 'integer', minimum: 1, maximum: 65535, description: 'Usually 993.' },
      imap_tls: { type: 'boolean', default: true, description: 'TLS from the start (port 993).' },
      smtp_host: { type: 'string', description: 'Leave out: this mailbox does not send.' },
      smtp_port: {
        type: 'integer',
        minimum: 1,
        maximum: 65535,
        description: 'Usually 465 or 587.',
      },
      smtp_tls: {
        type: 'boolean',
        description: 'true: TLS from the start (465); false: STARTTLS (587).',
      },
      first_scan_days: {
        type: 'integer',
        minimum: 1,
        maximum: 3650,
        default: 365,
        description: 'How far the first scan reaches back, in days.',
      },
      enabled: { type: 'boolean', default: true, description: 'Sync this mailbox.' },
    },
    required: ['imap_host', 'imap_port'],
  },
  handler: async (i): Promise<ToolHandlerResult> =>
    admin('/admin/mailbox', {
      id: i.id ?? null,
      address: i.address ?? '',
      displayName: i.display_name ?? null,
      password: i.password ?? '',
      imapHost: i.imap_host,
      imapPort: i.imap_port,
      imapSecure: i.imap_tls ?? true,
      smtpHost: i.smtp_host ?? null,
      smtpPort: i.smtp_port ?? null,
      smtpSecure: i.smtp_tls ?? true,
      firstScanDays: i.first_scan_days ?? 365,
      enabled: i.enabled ?? true,
    }),
};

export const sync_feed_set: BuiltinToolDef = {
  slug: 'sync_feed_set',
  mcpOnly: true,
  policy: writePolicy('adds or changes a calendar feed', { area: 'connectors', systemWhole: true }),
  name: 'Add or edit a calendar feed',
  description:
    "Add an iCal calendar feed (no `id`), or change one (`id`). Its events land in the calendar every 30 minutes. `url` is the feed's https or webcal address (it can carry a secret: it is never shown again); on an edit leave it out to keep it.",
  inputSchema: {
    type: 'object',
    properties: {
      id: idProp('The feed to change; leave out to add one'),
      name: { type: 'string', description: 'The name the calendar shows, e.g. `Team holidays`.' },
      url: {
        type: 'string',
        description: "The feed's iCal address, e.g. `https://calendar.example.com/a.ics`.",
      },
      enabled: { type: 'boolean', default: true, description: 'Sync this feed.' },
    },
    required: ['name'],
  },
  handler: async (i): Promise<ToolHandlerResult> =>
    admin('/admin/feed', {
      id: i.id ?? null,
      name: i.name ?? '',
      url: i.url ?? null,
      enabled: i.enabled ?? true,
    }),
};

export const sync_microsoft_app_set: BuiltinToolDef = {
  slug: 'sync_microsoft_app_set',
  mcpOnly: true,
  policy: writePolicy('sets the Microsoft app this box signs in with', {
    area: 'connectors',
    systemWhole: true,
  }),
  redactInputFields: ['client_secret'],
  name: 'Set the Microsoft app',
  description:
    "Set the Microsoft (Entra) app this box signs in with: its application (client) ID, a client secret (leave it out on a change to keep the stored one), the tenant (`common`, `organizations` or a tenant id) and the redirect URI registered on the app, exactly (`<this box's address>/api/microsoft/oauth/callback`). The app needs the delegated Graph rights Files.Read.All, Sites.Read.All, Mail.Read, Mail.Send and Calendars.Read.",
  inputSchema: {
    type: 'object',
    properties: {
      client_id: { type: 'string', description: "The app's application (client) ID, a GUID." },
      client_secret: { type: 'string', description: "A client secret's value from the app." },
      tenant: { type: 'string', default: 'common', description: 'e.g. `organizations`.' },
      redirect_uri: {
        type: 'string',
        description:
          'Exactly as registered, e.g. `https://brain.example.com/api/microsoft/oauth/callback`.',
      },
    },
    required: ['client_id', 'redirect_uri'],
  },
  handler: async (i): Promise<ToolHandlerResult> =>
    admin('/admin/microsoft/app', {
      clientId: i.client_id ?? '',
      clientSecret: i.client_secret ?? '',
      tenant: i.tenant ?? 'common',
      redirectUri: i.redirect_uri ?? '',
    }),
};

export const sync_microsoft_set: BuiltinToolDef = {
  slug: 'sync_microsoft_set',
  mcpOnly: true,
  policy: writePolicy("switches a Microsoft account's Outlook mail, or looks for its drives", {
    area: 'connectors',
    systemWhole: true,
  }),
  name: 'Change a Microsoft account',
  description:
    "Switch a connected Microsoft account's Outlook mail on or off (`mail`; only mail from contacts is kept; off keeps the stored mail), and/or look for its OneDrive and SharePoint drives again (`find_drives`: a new drive starts off). Turn a drive on with sync_drive_set.",
  inputSchema: {
    type: 'object',
    properties: {
      account_id: idProp('The Microsoft account'),
      mail: { type: 'boolean', description: 'Outlook mail on (true) or off (false).' },
      find_drives: { type: 'boolean', description: 'true: look for its drives again.' },
    },
    required: ['account_id'],
  },
  handler: async (i): Promise<ToolHandlerResult> => {
    const out: Record<string, unknown> = {};
    if (typeof i.mail === 'boolean') {
      const r = await admin('/admin/microsoft/mail', { accountId: i.account_id, on: i.mail });
      if (!r.ok) return r;
      out.mail = r.output;
    }
    if (i.find_drives === true) {
      const r = await admin('/admin/microsoft/drives', { accountId: i.account_id });
      if (!r.ok) return r;
      out.drives = r.output;
    }
    if (Object.keys(out).length === 0) return { ok: false, error: 'set `mail` or `find_drives`' };
    return { ok: true, output: out };
  },
};

export const sync_drive_browse: BuiltinToolDef = {
  slug: 'sync_drive_browse',
  mcpOnly: true,
  policy: {
    ...readPolicy({ area: 'connectors', systemWhole: true }),
    matrix: { none: "a drive's ids are Microsoft's, not items of the brain" },
  },
  name: 'Browse a drive',
  description:
    "One folder of a OneDrive or SharePoint drive (its top when `folder` is left out): each item's id, name, whether it is a folder, size and path. Use it to choose what syncs (sync_drive_set `selections`).",
  inputSchema: {
    type: 'object',
    properties: {
      drive_id: idProp('The drive'),
      folder: { type: 'string', description: "A folder's id from an earlier browse." },
    },
    required: ['drive_id'],
  },
  handler: async (i): Promise<ToolHandlerResult> =>
    admin('/admin/drive/browse', { driveId: i.drive_id, itemId: i.folder ?? '' }),
};

export const sync_drive_set: BuiltinToolDef = {
  slug: 'sync_drive_set',
  mcpOnly: true,
  policy: writePolicy('switches a drive or chooses what in it syncs', {
    area: 'connectors',
    systemWhole: true,
  }),
  name: 'Switch a drive or choose its folders',
  description:
    'Turn a OneDrive or SharePoint drive on or off (`enabled`; off keeps every synced file), and/or choose what in it syncs (`selections`, which replace the old ones; an empty list syncs the whole drive). Each selection is a folder or a file from sync_drive_browse: its `item_id`, `path` and `is_folder`. Files land in the brain as normal files every 5 minutes; a file outside the choice leaves the brain at the next run.',
  inputSchema: {
    type: 'object',
    properties: {
      drive_id: idProp('The drive'),
      enabled: { type: 'boolean', description: 'The drive syncs (true) or stops (false).' },
      selections: {
        type: 'array',
        maxItems: 500,
        description: 'What syncs; an empty list is the whole drive.',
        items: {
          type: 'object',
          properties: {
            item_id: { type: 'string', description: "The item's id from `sync_drive_browse`." },
            path: { type: 'string', description: 'From the drive top, e.g. `/Reports/2026`.' },
            is_folder: { type: 'boolean', description: 'A folder (true) or one file (false).' },
            name: { type: 'string', description: 'Its name, for display.' },
          },
          required: ['item_id', 'path', 'is_folder'],
        },
      },
    },
    required: ['drive_id'],
  },
  handler: async (i): Promise<ToolHandlerResult> => {
    const selections = Array.isArray(i.selections)
      ? (i.selections as Record<string, unknown>[]).map((s) => ({
          itemId: s.item_id,
          path: s.path,
          isFolder: s.is_folder,
          name: s.name,
        }))
      : undefined;
    if (typeof i.enabled !== 'boolean' && !selections) {
      return { ok: false, error: 'set `enabled` or `selections`' };
    }
    return admin('/admin/drive', {
      driveId: i.drive_id,
      ...(typeof i.enabled === 'boolean' ? { enabled: i.enabled } : {}),
      ...(selections ? { selections } : {}),
    });
  },
};

export const sync_remove: BuiltinToolDef = {
  slug: 'sync_remove',
  mcpOnly: true,
  policy: {
    ...writePolicy('removes a linked account', { area: 'connectors', systemWhole: true }, false),
    riskClass: 'delete',
  },
  name: 'Remove a linked account',
  description:
    "Remove a mailbox, a calendar feed or a Microsoft account by its id. A mailbox's password and a Microsoft account's tokens are deleted; stored mail and synced files stay in the brain. A feed's events leave the calendar. It waits for a run of that account under way.",
  inputSchema: {
    type: 'object',
    properties: { id: idProp('The mailbox, feed or Microsoft account') },
    required: ['id'],
  },
  handler: async (i): Promise<ToolHandlerResult> => admin('/admin/remove', { id: i.id }),
};

export const sync_run: BuiltinToolDef = {
  slug: 'sync_run',
  mcpOnly: true,
  policy: writePolicy('starts a sync of one account now', {
    area: 'connectors',
    systemWhole: true,
  }),
  name: 'Sync one account now',
  description:
    "Start a sync of one mailbox, feed, drive or Microsoft account's Outlook mail now (it runs in the background). sync_status shows the outcome.",
  inputSchema: {
    type: 'object',
    properties: { id: idProp('The mailbox, feed, drive or Microsoft account') },
    required: ['id'],
  },
  handler: async (i): Promise<ToolHandlerResult> => admin('/admin/run', { id: i.id }),
};

/** Registered on the MCP surface (build-server.ts); no agent is granted
 *  them. Each needs the Sync service (builtins.ts). */
export const SYNC_TOOLS: readonly BuiltinToolDef[] = [
  sync_status,
  sync_mailbox_set,
  sync_feed_set,
  sync_microsoft_app_set,
  sync_microsoft_set,
  sync_drive_browse,
  sync_drive_set,
  sync_remove,
  sync_run,
];
