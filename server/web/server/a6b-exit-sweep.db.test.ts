/**
 * The A6b exit sweep (workspaces arch plan v2, A6b: the system-pool exits
 * toward 40). Each group of exits that moves into the scope, or behind a
 * narrow definer, is recorded here on main BEFORE it moves, and compared
 * after: every answer must match, or be a named change with its reason. A
 * looser answer is a blocker.
 *
 * The logins: the brain's owner (the anchor, an Admin user), an Admin user
 * with every area, an Admin user without the users area, a member who
 * moderates P and is a plain user of Q, a plain user of Q, a member in no
 * workspace (the outsider). Workspaces: Admin, P, Q. Each group asks its
 * libraries in every context they run in (the system pool; a login's read
 * and write request scope as the session guard enters them; an assistant's
 * turn in Admin, P and Q with and without a login), and its routes through
 * the real app (createApp) with each login's session cookie.
 *
 * One record per section and check mode (MANTLE_ACTOR_CHECK: off, warn, on;
 * the suite runs this file in all three): __snapshots__/a6b-exit-sweep.
 * <section>.<mode>.txt. Recorded on main with A6B_RECORD=<section,...|all>;
 * a normal run only compares.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/a6b-exit-sweep.db.test.ts
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const MODE = (process.env.MANTLE_ACTOR_CHECK ?? 'warn').trim() || 'warn';
const RECORD = new Set(
  (process.env.A6B_RECORD ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const HERE = dirname(fileURLToPath(import.meta.url));
const snapOf = (section: string) =>
  join(HERE, '__snapshots__', `a6b-exit-sweep.${section}.${MODE}.txt`);

// Telegram sends are recorded, never sent (an approval card, a DM).
const tg = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock('@mantle/telegram', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/telegram')>()),
  sendApprovalCard: async (account: { botUsername: string }, chatId: string, card: unknown) => {
    tg.sent.push(`card ${account.botUsername} ${chatId} ${JSON.stringify(card)}`);
  },
  sendMessage: async (account: { botUsername: string }, chatId: string, text: string) => {
    tg.sent.push(`message ${account.botUsername} ${chatId} ${text}`);
    return null;
  },
}));

vi.mock('@/lib/audit', () => ({
  auditFireAndForget: () => undefined,
  requestMetaFrom: () => ({}),
  requestMeta: async () => ({ ip: null, userAgent: null }),
}));

// The object store is outside this box's test.
vi.mock('@mantle/storage/write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/storage/write')>()),
  putContent: async (body: Buffer) => {
    const { createHash } = await import('node:crypto');
    const sha256 = createHash('sha256').update(body).digest('hex');
    return { key: `test/${sha256}`, sha256, size: body.length, deduped: false };
  },
}));

/** The context of a cell: its key's last word (system, read:<login>,
 *  write:<login>, turn:<workspace>:<login|none>). */
const ctxOf = (k: string) => k.slice(k.lastIndexOf(' ') + 1);

/** The login a context's scope answers, or null (the system pool, a turn
 *  with no login). */
const scopeLoginOf = (ctx: string): string | null => {
  const m = /^(?:read|write):(\w+)$/.exec(ctx) ?? /^turn:\w+:(\w+)$/.exec(ctx);
  return m && m[1] !== 'none' ? m[1]! : null;
};

/** A change held to the scope's own login holds only where the cell asks for
 *  ANOTHER login: a broken own-login read must still fail the sweep. */
const asksAnotherLogin = (k: string, asked: string | null) =>
  ctxOf(k) !== 'system' && asked !== scopeLoginOf(ctxOf(k));

/** What each context's scope reads, as the definers see it (filled by the
 *  narrow-reads section before its cells): whether a scope is set and the
 *  fixture items it reads, by name. */
const SCOPE_FACTS = new Map<string, { active: boolean; reads: Set<string> }>();

/** Main's answer `was` ({ok: rows}) with only the rows `keep` holds. */
const keptOf = (was: string, keep: (row: any) => boolean) => {
  const v = JSON.parse(was) as { ok?: unknown[] };
  return Array.isArray(v.ok) ? JSON.stringify({ ok: v.ok.filter(keep) }) : null;
};

/** The login a queued call of the telegram section was asked by. */
const PEND_ASKER: Record<string, string | null> = {
  adminAll: 'adminAll',
  modP: 'modP',
  elevated: 'modP',
  none: null,
};

/** Main's recorded lines of the section being compared, by cell (the F4
 *  changes compare a write context's answer with main's read one). */
let RECORDED = new Map<string, string>();

/** The Admin logins whose write requests F4 moved into their scope. */
const F4_ADMIN_WRITE = /(?:^| )write:(owner|adminAll|adminNoUsers)$/;

/** The create miss of an Admin user who is not a Moderator of Admin, its
 *  create landing in Admin (kind-root, rule-in-query). */
const F4_CREATE_MISS =
  'sql INSERT on nodes: no Moderator of the home (refused when the check is on)';
/** The cells of an Admin user's create with no ?ws= (F4: it lands in Admin). */
const F4_ADMIN_CREATE =
  /^(POST file at root|upsertFile root|POST \/api\/apps) (write:)?(adminAll|adminNoUsers)$/;
/** An app's own row, made in the same create: the item it may not edit. */
const F4_CREATE_APP_MISS = 'sql INSERT on apps: no edit of the item (refused when the check is on)';

/**
 * Plan v3 S3 (docs/actors.md, "Plan v3 S3"), in every section: profiles and
 * app_table_exports are write-role tables, so a write of them is no gap.
 *  - main's line lists the gap it ran again (warn: the system pool; on: the
 *    checked rerun); the same answer now lists none;
 *  - an export link removed by the library called past the tools' gate
 *    (`app_table_export_remove` asks edit of the app first) in a scope that
 *    does not manage the app, a read context too: refused before the
 *    delete (fix round 3: the library asks manage of the app first), where
 *    main removed it on the system pool. The Moderators' cells (P's) and
 *    the owner's answer as main.
 */
const S3_GAP_TABLES = /^permission denied for table (profiles|app_table_exports)$/;
/** An export change refused (fix round 3): no_read, or no_edit in words. */
const S3_EXPORT_REFUSALS = [
  'not allowed to edit this item',
  "You cannot change this app's exported tables: that is for a Moderator of the app's workspace (an app with no workspace: the Admin workspace).",
].map((message) =>
  JSON.stringify({ refused: { name: 'Error', status: null, code: '42501', message } }),
);
type S3Change = {
  cells: RegExp;
  reason: string;
  now?: string;
  nowTest?: (now: string, k: string, was: string) => boolean;
};
const S3_WARN_CHANGES: ReadonlyArray<S3Change> = [
  {
    cells: /./,
    reason: 'plan v3 S3: no gap table is left; the same answer, its gap (and the run again) gone.',
    nowTest: (now, _k, was) => {
      type Was = { v?: unknown; misses?: string[]; gaps?: string[] };
      let w: Was | null;
      try {
        w = JSON.parse(was) as Was | null;
      } catch {
        return false;
      }
      if (!w || typeof w !== 'object' || !Array.isArray(w.gaps) || w.gaps.length === 0) {
        return false;
      }
      if (!w.gaps.every((g) => S3_GAP_TABLES.test(g))) return false;
      const misses = w.misses ?? [];
      return now === JSON.stringify(misses.length ? { v: w.v, misses, gaps: [] } : w.v);
    },
  },
  {
    // Fix round 3: the library asks manage of the app first (one read in
    // the scope), so a read context is asked too (main removed the link on
    // the system pool there), and the answer is the refusal (round 2's
    // `{"ok":false}`, no row, is gone): no_read where the scope does not
    // read the app, no_edit with the export's words where it reads it.
    cells:
      /^removeAppTableExport (written|team) (turn:admin:(adminAll|none|owner)|turn:Q:userQ|turn:P:none|(read|write):(adminAll|adminNoUsers|outsider|userQ))$/,
    reason:
      "plan v3 S3: an export row is the write role's with manage of the app; a scope that " +
      'does not manage it is refused before anything is written (fix round 3).',
    nowTest: (now) => S3_EXPORT_REFUSALS.includes(now),
  },
];

/** Main's warn lines of the section being compared (off only, plan v3 S3). */
let WARN_RECORDED = new Map<string, string>();

/** S3's changes, and off's: a scoped write runs on the write role in off
 *  as in warn (the mode never picks the pool), so an off cell answers as
 *  main's warn cell did, with S3's own changes to warn. */
const S3_CHANGES: ReadonlyArray<S3Change> = [
  ...S3_WARN_CHANGES,
  {
    cells: /./,
    reason:
      "plan v3 S3: off runs a scoped write on the write role, its checks reporting as warn's: " +
      "the cell answers as main's warn cell (and S3's warn changes).",
    nowTest: (now, k) => {
      if (MODE !== 'off') return false;
      const line = WARN_RECORDED.get(k);
      if (line === undefined) return false;
      const warn = line.slice(line.indexOf(' => ') + 4);
      // F4's warn change of an Admin user's create landing in Admin (its
      // miss logged, F4_CHANGES): main's warn line is from before F4.
      let f4 = false;
      try {
        const p = JSON.parse(now) as { v?: unknown; misses?: string[]; gaps?: string[] } | null;
        f4 =
          F4_ADMIN_CREATE.test(k) &&
          !!p &&
          Array.isArray(p.misses) &&
          p.misses.includes(F4_CREATE_MISS) &&
          p.misses.every((x) => x === F4_CREATE_MISS || x === F4_CREATE_APP_MISS) &&
          (p.gaps ?? []).length === 0 &&
          JSON.stringify(p.v) === warn;
      } catch {
        // not JSON: no F4 form
      }
      return (
        f4 ||
        now === warn ||
        S3_WARN_CHANGES.some(
          (c) =>
            c.cells.test(k) &&
            ((c.now !== undefined && now === c.now) || !!c.nowTest?.(now, k, warn)),
        )
      );
    },
  },
];

/**
 * The F4 changes (docs/actors.md, "Admin writes on the write role (F4)"),
 * in every section: an Admin user's write request enters its scope, its
 * reads with it, as a member's does (it ran on the system pool with only
 * its scope noted before). A library called in an Admin user's write
 * context answers as main answered it in the same login's READ context
 * (its reads in the same scope); the writes themselves are named below.
 */
const F4_CHANGES: ReadonlyArray<{
  cells: RegExp;
  reason: string;
  nowTest: (now: string, k: string, was: string) => boolean;
}> = [
  {
    cells: F4_ADMIN_WRITE,
    reason:
      "an Admin user's write context reads in its scope now: the same answer as main's read " +
      'context of that login (its scope), never a row its scope does not read.',
    nowTest: (now, k) => {
      const read = RECORDED.get(k.replace(/write:(\w+)$/, 'read:$1'));
      return read !== undefined && read.slice(read.indexOf(' => ') + 4) === now;
    },
  },
  {
    cells: /^notifyPendingCreated \S+ write:(owner|adminAll|adminNoUsers)$/,
    reason:
      "a queued call's Telegram card is not sent from an Admin user's write context: the card " +
      "route and the bot's row are read in the caller's scope (A6b), which sends none from any " +
      'scope (every read context, every member). The in-app badge and /pending still have it. ' +
      'The errors it logs are timing (a detached send); the card is never sent.',
    nowTest: (now) => {
      const v = JSON.parse(now) as { sent: unknown[]; errors: string[] };
      return (
        v.sent.length === 0 &&
        v.errors.every((e) => e.startsWith('[pending:notify] Telegram approval push failed'))
      );
    },
  },
  {
    cells: F4_ADMIN_CREATE,
    reason:
      "a create with no ?ws= by an Admin user who is not a Moderator of Admin (this fixture's " +
      'adminAll and adminNoUsers) lands in Admin on the write role, where the create check ' +
      'needs a Moderator of the home: warn makes it and logs the miss, on refuses it ' +
      '(docs/workspaces.md: "An admin login is its user and a Moderator there"). Main made it ' +
      'on the system pool unchecked. Off: the system pool, as main.',
    nowTest: (now, _k, was) => {
      const v = JSON.parse(now) as { v?: unknown; misses?: string[]; gaps?: string[] };
      if (MODE === 'warn') {
        return (
          JSON.stringify(v.v) === was &&
          (v.misses ?? []).includes(F4_CREATE_MISS) &&
          (v.misses ?? []).every((x) => x === F4_CREATE_MISS || x === F4_CREATE_APP_MISS) &&
          (v.gaps ?? []).length === 0
        );
      }
      if (MODE !== 'on') return false;
      // on: refused at the database. Over HTTP the mapper's 403, never the
      // database's own words; a library call throws the database's error
      // (the route's mapper answers it).
      const http = v as { status?: number };
      if (http.status !== undefined) {
        return http.status === 403 && /item-workspace/.test(now) && !/Failed query/.test(now);
      }
      return /^\{"refused":/.test(now) && now.includes('insert into');
    },
  },
  {
    cells: /^row of kr-lib-\d+\.txt$/,
    reason:
      'on: the row of the refused create above (an Admin user who is not a Moderator of ' +
      'Admin, upsertFile in its write context) is not made.',
    nowTest: (now, k) => {
      if (MODE !== 'on' || now !== '[]') return false;
      // The context of the upsertFile cell this row belongs to (in order).
      const ctxs = [...RECORDED.keys()]
        .filter((x) => x.startsWith('upsertFile root '))
        .map((x) => x.slice('upsertFile root '.length));
      const n = Number(/kr-lib-(\d+)/.exec(k)![1]);
      return /^write:(adminAll|adminNoUsers)$/.test(ctxs[n - 1] ?? '');
    },
  },
  {
    cells: /^GET files root adminNoUsers$/,
    reason:
      'on: the files root lists what main listed but for the files the create above refused ' +
      '(an Admin user who is not a Moderator of Admin).',
    nowTest: (now, _k, was) => {
      if (MODE !== 'on') return false;
      type L = { status: number; body: { files?: { filename: string }[] } };
      const w = JSON.parse(was) as L;
      const refused = new Set(['kr-adminall.txt', 'kr-adminnousers.txt']);
      w.body.files = (w.body.files ?? []).filter((f) => !refused.has(f.filename));
      return JSON.stringify(w) === now;
    },
  },
];

/** Cells F4 takes away in on: the cells that follow a create it refuses
 *  there (an app the Admin user who is not a Moderator of Admin could not
 *  make has no switch to change and no row). */
const F4_MISSING_ON = /^(PATCH \/api\/apps\/:id mcpAccess|app row) (adminAll|adminNoUsers)$/;

/**
 * Cells whose answer changed on purpose, per section: the cells a pattern
 * names, its reason, and either `back`, which turns the new answer into
 * main's form (the cell must then read exactly as main recorded it), or
 * `now`, the exact new answer (for a change `back` cannot undo: a row main
 * made that the new code does not).
 */
const NAMED_CHANGES: Record<
  string,
  ReadonlyArray<{
    cells: RegExp;
    reason: string;
    back?: (now: string) => string;
    now?: string;
    /** For a new answer that depends on the cell (a refusal quoting its
     *  own arguments, a change held to who asks): whether `now` is the
     *  named change for cell `k`, whose answer on main was `was`. */
    nowTest?: (now: string, k: string, was: string) => boolean;
    /** What main's answer must have been for the change to hold. */
    was?: RegExp;
  }>
> = {
  'client-sourced': [
    {
      cells: /^removeAppTableExport (written|team) (read|write|turn):\S+$/,
      reason:
        'the pre-check removal Part 3 (docs/actors.md): removeAppTableExport asks the edit right ' +
        "of the app in the caller's scope first (assertItemRight), where the tool's item " +
        'pre-check asked it and the library asked nothing. A scope that may not edit the app ' +
        "(its workspace P: not the owner's or modP's) is refused with the edit check's error, " +
        'before the link is read; the system, the owner and modP answer as main. Stricter, ' +
        'never looser (turn:P:none was refused on main too, by the delete itself).',
      nowTest: (now, k) =>
        !/ (read|write):(owner|modP)$| turn:P:modP$/.test(k) &&
        now ===
          JSON.stringify({
            refused: {
              name: 'Error',
              status: null,
              code: '42501',
              message: 'not allowed to edit this item',
            },
          }),
    },
  ],
  'owner-preferences': [
    {
      cells: /^missing anchor row after$/,
      reason:
        "a member's landing read no longer makes the anchor's missing profile row: it read the " +
        "anchor's row on the system pool and so inserted it there; it reads in the member's scope " +
        'now, where the insert (a gap table the member may not write for another login) is refused ' +
        "and caught, as every other cross-login insert there is. The member's answer is the same " +
        "(no site name either way); the anchor's row is made on the anchor's next read.",
      now: '[]',
    },
  ],
  'rule-in-query': [
    {
      // The pre-check removal part 2 (round 4): an app's PATCH asks the
      // caller's edit itself (assertItemRight, in every mode) where the
      // HTTP gate refused it; the one mapper answers the refusal, the same
      // words with its code.
      cells: /^PATCH \/api\/apps\/:id mcpAccess (adminAll|adminNoUsers)$/,
      reason:
        "an Admin user's mcpAccess switch on an app its scope may not edit is refused by the " +
        "route's own edit check (assertItemRight) since the HTTP item gate's apps entry went; " +
        'the 403 item-workspace is the one mapper\'s, which adds "code":"forbidden".',
      was: /"status":403,"body":\{"error":"forbidden","reason":"item-workspace","message":"You cannot change this item in your workspaces\."\}/,
      now: '{"status":403,"body":{"error":"forbidden","reason":"item-workspace","code":"forbidden","message":"You cannot change this item in your workspaces."}}',
    },
    {
      cells: /^GET \/api\/assistant\/thread adminNoUsers( agent=\w+)?$/,
      reason:
        'an Admin user assigned an assistant of a workspace it is not in no longer sees that ' +
        'assignment in its chat bundle: the assignment is read in its scope now, where the agents ' +
        'row rule (0254) hides an assistant of a workspace outside it. It could not chat with that ' +
        "assistant on main either (the bundle's agents and its selected agent left it out); only " +
        'the slug was shown. Stricter, never looser.',
      back: (now) =>
        now.replace('"assigned":null}}', '"assigned":{"slug":"a6b-P","assignedAt":"<time>"}}}'),
    },
  ],
  'narrow-reads': [
    {
      cells: /^loginConnectorRule \w+ (read|write|turn):/,
      reason:
        "a login's connector rule asked in a scope for ANOTHER login answers as for a login in no " +
        'workspace: its rows come from a definer that holds the scope to its own login ' +
        '(mantle_login_connector_rows: the caller from the scope, never from an argument). Every ' +
        "product caller asks for the scope's own login (the MCP connection's pre-run check, an " +
        "app run's broker) or runs on the system pool (dispatch, the MCP listing), where it " +
        'answers as main. Stricter, never looser. Only where the cell asks for another login ' +
        "than the scope's: the scope's own login must answer as main.",
      nowTest: (now, k) =>
        asksAnotherLogin(k, k.split(' ')[1]!) &&
        now ===
          JSON.stringify({
            ok: Array(3).fill(
              'You are not a user of any workspace on this brain, so connector tools do not run for you.',
            ),
          }),
    },
    {
      cells: /^appConnectorRefused (read|write) (read|write|turn):\S+$/,
      reason:
        "an app's connector verdict asked in a scope that does not read the app answers as for " +
        'an app in no workspace: its holders come from a definer held to the apps the scope reads ' +
        "(mantle_app_holders). The broker asks it in the app run's scope, which reads the app. " +
        'Stricter, never looser. Only in a scope that does not read the app (SCOPE_FACTS): a ' +
        'scope that reads it must answer as main.',
      nowTest: (now, k) => {
        const f = SCOPE_FACTS.get(ctxOf(k));
        return (
          !!f?.active &&
          !f.reads.has('app:nr') &&
          now ===
            JSON.stringify({
              ok: 'This app is in no workspace, so connector tools do not run from it.',
            })
        );
      },
    },
    {
      cells: /^contactSharingByContact (read|write|turn):\S+$/,
      reason:
        "a contact's sharing dates asked in a scope answer only the contacts the scope reads " +
        '(mantle_contact_sharing, A6b fix round). Every product caller passes contacts it read ' +
        'in the scope first, so their answers are unchanged. Stricter, never looser: exactly ' +
        "main's entries, less those of contacts the scope does not read.",
      nowTest: (now, k, was) => {
        const f = SCOPE_FACTS.get(ctxOf(k));
        return !!f?.active && now === keptOf(was, (e) => f.reads.has(e[0]));
      },
    },
  ],
  telegram: [
    {
      cells: /^replay_window telegram asker=\w+ (read|write|turn):\S+$/,
      reason:
        "the replay of a login's Telegram history asked in a scope for ANOTHER asker (a surface " +
        "that names a login other than the scope's) answers none: its definer holds the scope to " +
        'its own login (mantle_tg_replay). A turn asks for its own login (its stamp, its scope). ' +
        "Stricter, never looser. Only where the asker is not the scope's own login.",
      nowTest: (now, k) =>
        asksAnotherLogin(k, k.split(' ')[2]!.slice('asker='.length)) &&
        now ===
          JSON.stringify({
            ok: {
              ok: true,
              output: {
                window: { from: '<time>', to: '<time>' },
                surface: 'telegram',
                count: 0,
                truncated: false,
                turns: [],
              },
            },
          }),
    },
    {
      cells: /^(listMyTelegramChats|listModeratedTelegramChats) \w+ (read|write|turn):\S+$/,
      reason:
        "a login's own chats and its moderated chats asked in a scope for ANOTHER login answer " +
        'none: their definers hold the scope to its own login (mantle_tg_my_chats, ' +
        "mantle_tg_moderated_chats). The routes ask for the request's own login. Stricter, " +
        "never looser. Only where the cell asks for another login than the scope's.",
      nowTest: (now, k) =>
        asksAnotherLogin(k, k.split(' ')[1]!) && now === JSON.stringify({ ok: [] }),
    },
    {
      cells: /^notifyPendingCreated \w+ (read|write|turn):\S+$/,
      reason:
        "the approval card never left a workspace scope (the bot's row was refused there, so " +
        "no card was sent: main's `sent` is empty in every scoped cell). Its route is read by " +
        'its definer now (mantle_pending_card_route), which in a scope answers only a call the ' +
        "scope's own login asked: for another login's call it stops before the bot's row, so " +
        "main's logged refusal (and the write role's gap it met) is not logged. No card either " +
        "way; the in-app badge is unchanged. Only for a call the scope's own login did not ask " +
        "(one no login asked is the anchor's, or a scope's with no login): the definer's own " +
        'rule, so an own call that answers otherwise fails the sweep.',
      was: /"sent":\[\]/,
      nowTest: (now, k) => {
        const asker = PEND_ASKER[k.split(' ')[1]!];
        const login = scopeLoginOf(ctxOf(k));
        const own =
          asker === undefined
            ? true
            : asker === null
              ? login === null || login === 'owner'
              : asker === login;
        return (
          ctxOf(k) !== 'system' &&
          !own &&
          now === JSON.stringify({ done: {}, sent: [], errors: [] })
        );
      },
    },
  ],
  'workspace-create': [
    {
      cells: /^createWorkspace read:\w+$/,
      reason:
        'a workspace made from a READ scope is refused: its definer (mantle_ws_create) is the ' +
        "write role's (WRITE_ROLE_FUNCTIONS), where the system pool made it whatever the scope " +
        'before. The route makes it in a write (a member on the write role, an Admin user on the ' +
        'system pool), which answers as main. Stricter, never looser.',
      was: /"rows":\{"ws":\[\{"created_by"/,
      nowTest: (now, k) => {
        const who = k.slice('createWorkspace read:'.length);
        return (
          now ===
          JSON.stringify({
            res: {
              refused: {
                name: 'Error',
                status: null,
                code: null,
                message:
                  'Failed query: select "public"."mantle_ws_create"($1::uuid, $2::uuid,\n' +
                  `                     $3, $4) as id\nparams: login:owner,login:${who},a6b-lib-read:${who},lib`,
              },
            },
            rows: { ws: [], users: [], events: [] },
          })
        );
      },
    },
  ],
};

type Json = Record<string, any>;

const id = (n: number) => `a6b00000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const L = {
  owner: id(1),
  adminAll: id(2),
  adminNoUsers: id(3),
  modP: id(4),
  userQ: id(6),
  outsider: id(7),
} as const;
type LoginKey = keyof typeof L;
const LOGINS = Object.keys(L) as LoginKey[];
const ADMINS: readonly LoginKey[] = ['owner', 'adminAll', 'adminNoUsers'];
const W = { P: id(101), Q: id(102) };
const AG = { admin: id(401), P: id(402), Q: id(403) };

describe.skipIf(!URL)('the A6b exit sweep', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let content: typeof import('@mantle/content');
  let files: typeof import('@mantle/files');
  let rt: typeof import('@mantle/runtime/agent');
  let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
  let cookieOf: (login: string) => string;
  let adminWs = '';

  const names = new Map<string, string>();

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  /** A statement in the context it is called in (the caller's scope). */
  const x2 = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.db.execute(q)) as unknown as T[];

  /** A value with every known id named, unknown ids, times and secrets
   *  blanked (so a cell reads the same on every run). */
  const norm = (v: unknown): unknown => {
    let s = JSON.stringify(v, (_k, val) => (val instanceof Map ? Object.fromEntries(val) : val));
    if (s === undefined) return null;
    s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (u) => {
      return names.get(u.toLowerCase()) ?? '<uuid>';
    });
    s = s.replace(
      /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?/g,
      '<time>',
    );
    s = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<date>');
    s = s.replace(/mtlk_[A-Za-z0-9_-]+/g, '<key>');
    s = s.replace(/"(sha256|etag|version|appVersion)":"[^"]*"/g, '"$1":"<x>"');
    return JSON.parse(s);
  };

  /** The answer of `fn`, or the refusal it threw. */
  const answer = async (fn: () => Promise<unknown>): Promise<unknown> => {
    try {
      return { ok: await fn() };
    } catch (err) {
      const e = err as { status?: number; code?: string; name?: string; message?: string };
      return {
        refused: {
          name: e.name,
          status: e.status ?? null,
          code: e.code ?? null,
          message: e.message,
        },
      };
    }
  };

  // ── contexts ───────────────────────────────────────────────────────────
  const isAdmin = (who: LoginKey) => ADMINS.includes(who);
  /** A login's request, as the session guard enters it: a read and a
   *  write in the login's scope (a write on the write role; an Admin
   *  user's too since F4, on the system pool with its scope noted before). */
  const inRequest = async <T>(who: LoginKey, write: boolean, fn: () => Promise<T>) => {
    const scope = await m.viewerScopeFor({ login: L[who] });
    return m.runInRequestSlot(async () => {
      m.enterRequestScope(scope, { writes: write, drafts: isAdmin(who) });
      return fn();
    });
  };
  /** An assistant's turn: Admin's, P's or Q's, answering `who` (or none). */
  const inTurn = <T>(ag: keyof typeof AG, who: LoginKey | null, fn: () => Promise<T>) =>
    rt.withAgentScope(
      { id: AG[ag], workspaceId: ag === 'admin' ? adminWs : W[ag] },
      fn,
      who ? (ag === 'admin' ? { ownerLoginId: L[who] } : { loginId: L[who] }) : {},
    );
  /** Every context a library runs in, by name. */
  const CONTEXTS: ReadonlyArray<[string, <T>(fn: () => Promise<T>) => Promise<T>]> = [
    ['system', (fn) => fn()],
    ...LOGINS.flatMap(
      (who) =>
        [
          [`read:${who}`, (fn) => inRequest(who, false, fn)],
          [`write:${who}`, (fn) => inRequest(who, true, fn)],
        ] as [string, <T>(fn: () => Promise<T>) => Promise<T>][],
    ),
    ['turn:admin:owner', (fn) => inTurn('admin', 'owner', fn)],
    ['turn:admin:adminAll', (fn) => inTurn('admin', 'adminAll', fn)],
    ['turn:admin:none', (fn) => inTurn('admin', null, fn)],
    ['turn:P:modP', (fn) => inTurn('P', 'modP', fn)],
    ['turn:P:none', (fn) => inTurn('P', null, fn)],
    ['turn:Q:userQ', (fn) => inTurn('Q', 'userQ', fn)],
  ];

  /** A request through the real app as `who` (null: no session). */
  /** A request through the real app as `who` (a login's session cookie, a
   *  key's bearer, or null: no credential). `form`: a multipart body. */
  const http = async (
    who: LoginKey | { bearer: string } | null,
    method: string,
    path: string,
    body?: unknown,
    form?: FormData,
  ) => {
    const headers: Record<string, string> = form ? {} : { 'content-type': 'application/json' };
    if (who && typeof who === 'object') headers.authorization = `Bearer ${who.bearer}`;
    else if (who) headers.cookie = cookieOf(L[who]);
    const res = await app.request(path, {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD'
        ? {}
        : { body: form ?? JSON.stringify(body ?? {}) }),
    });
    const text = await res.text().catch(() => '');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    }
    return { status: res.status, body: parsed };
  };
  /** A body with its short-lived parts blanked (an asset token). */
  const blank = (v: { status: number; body: unknown }) => {
    const b = v.body as Json | null;
    if (b && typeof b === 'object' && 'assetToken' in b) b.assetToken = '<token>';
    if (b && typeof b === 'object' && 'secret' in b) b.secret = '<secret>';
    return v;
  };

  // ── sections ───────────────────────────────────────────────────────────
  /** Run one section: its cells, then record (A6B_RECORD) or compare. */
  const section = async (
    name: string,
    body: (cell: (k: string, v: unknown) => void) => Promise<void>,
  ) => {
    const cells: string[] = [];
    // A cell carries the check misses (warn: what on refuses) and the
    // write role's gaps its own statements met, taken after each cell.
    m.takeActorMisses();
    m.takeWriteRoleGaps();
    await body((k, v) => {
      const misses = [...new Set(m.takeActorMisses().map((x) => `${x.source} ${x.check}`))].sort();
      const gaps = [...new Set(m.takeWriteRoleGaps())].sort();
      const out = misses.length || gaps.length ? { v, misses, gaps } : v;
      cells.push(`${k} => ${JSON.stringify(norm(out))}`);
    });
    const path = snapOf(name);
    if (RECORD.has(name) || RECORD.has('all')) {
      writeFileSync(path, `${cells.join('\n')}\n`);
      return;
    }
    expect(existsSync(path), `${path}: record it on main (A6B_RECORD=${name})`).toBe(true);
    const recorded = readFileSync(path, 'utf8').trimEnd().split('\n');
    const was = new Map(recorded.map((l) => [l.slice(0, l.indexOf(' => ')), l]));
    RECORDED = was;
    const warnPath = join(HERE, '__snapshots__', `a6b-exit-sweep.${name}.warn.txt`);
    WARN_RECORDED =
      MODE === 'off' && existsSync(warnPath)
        ? new Map(
            readFileSync(warnPath, 'utf8')
              .trimEnd()
              .split('\n')
              .map((l) => [l.slice(0, l.indexOf(' => ')), l]),
          )
        : new Map();
    const now = new Map(cells.map((l) => [l.slice(0, l.indexOf(' => ')), l]));
    const problems: string[] = [];
    for (const [k, line] of was) {
      const cur = now.get(k);
      if (cur === undefined) {
        if (!(MODE === 'on' && F4_MISSING_ON.test(k))) problems.push(`missing: ${k}`);
        continue;
      }
      if (cur === line) continue;
      const value = cur.slice(cur.indexOf(' => ') + 4);
      const wasValue = line.slice(line.indexOf(' => ') + 4);
      // Every named change whose pattern holds the cell is asked (F4's
      // apply in every section, beside the section's own).
      const named: ReadonlyArray<{
        cells: RegExp;
        back?: (now: string) => string;
        now?: string;
        nowTest?: (now: string, k: string, was: string) => boolean;
        was?: RegExp;
      }> = [...(NAMED_CHANGES[name] ?? []), ...F4_CHANGES, ...S3_CHANGES].filter((c) =>
        c.cells.test(k),
      );
      const holds = named.some((c) => {
        const wasOk = !('was' in c) || !c.was || c.was.test(line);
        if (!wasOk) return false;
        if ('back' in c && c.back && `${k} => ${c.back(value)}` === line) return true;
        if ('now' in c && c.now !== undefined && value === c.now) return true;
        return !!c.nowTest && c.nowTest(value, k, wasValue);
      });
      if (holds) continue;
      problems.push(`changed: ${line}\n     now: ${cur}`);
    }
    for (const k of now.keys()) if (!was.has(k)) problems.push(`new cell: ${k}`);
    expect(problems, `section ${name} (${MODE})`).toEqual([]);
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    // The vault seals with a 32-byte key; the viewer roles' passwords come
    // from MANTLE_MASTER_KEY, which the run may have set to the test key
    // (CI): seal under MANTLE_MASTER_KEY_NEXT then (packages/crypto), and
    // leave the role passwords alone.
    if (Buffer.from(process.env.MANTLE_MASTER_KEY, 'base64').length !== 32) {
      process.env.MANTLE_MASTER_KEY_NEXT ??= Buffer.alloc(32, 6).toString('base64');
    }
    process.env.SESSION_SECRET = 'a6b-exit-sweep-secret-at-least-32-characters';
    process.env.MANTLE_FILES_ROOT = mkdtempSync(join(tmpdir(), 'a6b-files-'));
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    content = await import('@mantle/content');
    files = await import('@mantle/files');
    rt = await import('@mantle/runtime/agent');

    for (const [k, v] of Object.entries(L)) names.set(v, `login:${k}`);
    for (const [k, v] of Object.entries(W)) names.set(v, `ws:${k}`);
    for (const [k, v] of Object.entries(AG)) names.set(v, `agent:${k}`);
    for (const k of LOGINS) {
      await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
                  values (${L[k]}, ${`a6b-${k}@example.invalid`}, 'x', ${k === 'owner'},
                          ${isAdmin(k) ? 'admin' : 'member'}, ${k})`);
    }
    await x(sql`insert into spaces (id, kind, login_id) values (${L.owner}, 'brain', ${L.owner})
                on conflict (id) do nothing`);
    // As the migrator runs it (the runtime role may not: arch A9).
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch(scratch!.url);
    const [adm] = await x<{ id: string }>(
      sql`select id::text as id from workspaces where owner_id = ${L.owner} and is_admin`,
    );
    adminWs = adm!.id;
    names.set(adminWs, 'ws:Admin');
    await x(sql`insert into workspaces (id, owner_id, name) values
      (${W.P}, ${L.owner}, 'Proj'), (${W.Q}, ${L.owner}, 'Quay')`);
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator) values
        (${adminWs}, ${L.adminAll}, false), (${adminWs}, ${L.adminNoUsers}, false),
        (${W.P}, ${L.owner}, true), (${W.P}, ${L.modP}, true),
        (${W.Q}, ${L.modP}, false), (${W.Q}, ${L.userQ}, false)
      on conflict (workspace_id, login_id) do update set moderator = excluded.moderator`);
    await x(sql`update workspace_users set limits = '{"areas":{"users":false}}'::jsonb
                 where workspace_id = ${adminWs} and login_id = ${L.adminNoUsers}`);
    for (const w of await x<{ id: string; name: string }>(
      sql`select id::text as id, name from workspaces where owner_id = ${L.owner}`,
    )) {
      if (!names.has(w.id)) names.set(w.id, `ws:other(${w.name})`);
    }
    // The assistants: Admin's, P's and Q's.
    for (const [k, wid] of [
      ['admin', adminWs],
      ['P', W.P],
      ['Q', W.Q],
    ] as const) {
      await x(sql`insert into agents (id, owner_id, slug, name, model, system_prompt, workspace_id, memory_config)
                  values (${AG[k]}, ${L.owner}, ${`a6b-${k}`}, ${`${k} assistant`}, 'test/model', 'p', ${wid},
                          '{"chunk_limit":0,"content_hit_limit":0,"corpus_map_limit":0}'::jsonb)`);
    }

    // P's and Q's assistants are their workspaces' (a resource each).
    await x(sql`insert into workspace_resources (workspace_id, type, ref_id) values
      (${W.P}, 'assistant', ${AG.P}), (${W.Q}, 'assistant', ${AG.Q})`);

    const tokens = await import('../lib/auth/tokens');
    cookieOf = (login) => `mantle_session=${tokens.buildSessionCookie(login).value}`;
    const { createApp } = await import('./app');
    app = await createApp();
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  // ── owner-preferences: loadProfilePreferences, the landing's site name ──
  it('owner-preferences', async () => {
    await x(sql`insert into profiles (user_id, preferences) values
      (${L.owner}, ${JSON.stringify({ timezone: 'Europe/Berlin', siteName: 'Sweep Brain', locale: 'de-DE' })}::jsonb),
      (${L.adminAll}, ${JSON.stringify({ timezone: 'Pacific/Auckland' })}::jsonb),
      (${L.modP}, ${JSON.stringify({ timezone: 'Asia/Tokyo', siteName: 'not the brand' })}::jsonb),
      (${L.userQ}, ${JSON.stringify({ timezone: 'America/Lima' })}::jsonb)
      on conflict (user_id) do update set preferences = excluded.preferences`);
    const pick = (p: Json) => ({ tz: p.timezone, site: p.siteName ?? null, locale: p.locale });
    await section('owner-preferences', async (cell) => {
      for (const [ctx, run] of CONTEXTS) {
        for (const target of ['owner', 'adminAll', 'modP', 'userQ'] as const) {
          cell(
            `prefs ${ctx} of=${target}`,
            await answer(() =>
              run(async () => pick(await content.loadProfilePreferences(L[target]))),
            ),
          );
        }
      }
      for (const who of LOGINS) {
        cell(`GET /api/home ${who}`, await http(who, 'GET', '/api/home'));
        cell(`GET /api/home?ws=P ${who}`, await http(who, 'GET', `/api/home?ws=${W.P}`));
        cell(`GET /api/member/home ${who}`, await http(who, 'GET', '/api/member/home'));
      }
      // The anchor's row missing: a member's landing (the profile row is
      // made on its first read).
      await x(sql`delete from profiles where user_id = ${L.owner}`);
      cell('missing GET /api/home?ws=P modP', await http('modP', 'GET', `/api/home?ws=${W.P}`));
      cell(
        'missing anchor row after',
        await x(sql`select preferences from profiles where user_id = ${L.owner}`),
      );
      await x(sql`delete from profiles where user_id = ${L.owner}`);
      cell(
        'missing prefs turn:admin:adminAll of=owner',
        await answer(() =>
          inTurn('admin', 'adminAll', async () =>
            pick(await content.loadProfilePreferences(L.owner)),
          ),
        ),
      );
      cell(
        'missing anchor row after turn',
        await x(sql`select preferences from profiles where user_id = ${L.owner}`),
      );
      await x(sql`insert into profiles (user_id, preferences) values
        (${L.owner}, ${JSON.stringify({ timezone: 'Europe/Berlin', siteName: 'Sweep Brain', locale: 'de-DE' })}::jsonb)
        on conflict (user_id) do update set preferences = excluded.preferences`);
    });
  });

  // ── kind-root: the files root, read whatever the scope holds ───────────
  it('kind-root', async () => {
    const rootRows = () =>
      x<{ n: number }>(
        sql`select count(*)::int as n from nodes where owner_id = ${L.owner} and type = 'branch' and path::text = 'files'`,
      );
    await section('kind-root', async (cell) => {
      // No root yet: a member's list makes it (the read path's repair).
      cell('root before', await rootRows());
      cell(
        'GET files root modP (no root)',
        await http('modP', 'GET', '/api/files/files?parent=files'),
      );
      cell('root after modP list', await rootRows());
      for (const [ctx, run] of CONTEXTS) {
        cell(
          `ensureFilesRootBranch ${ctx}`,
          await answer(() =>
            run(async () => (await files.ensureFilesRootBranch(L.owner)) !== null),
          ),
        );
      }
      for (const who of LOGINS) {
        cell(`GET files root ${who}`, await http(who, 'GET', '/api/files/files?parent=files'));
        const filename = `kr-${who}.txt`;
        cell(
          `POST file at root ${who}`,
          await http(who, 'POST', '/api/files/files', {
            parentPath: 'files',
            filename,
            content: `from ${who}`,
            confirm: true,
          }),
        );
        cell(
          `row of ${filename}`,
          await x(sql`select n.title, n.path::text as path,
                             (select array_agg(g.workspace_id::text order by g.workspace_id)
                                from item_grants g where g.node_id = n.id) as held
                        from nodes n where n.owner_id = ${L.owner} and n.type = 'file'
                         and n.data->>'filename' = ${filename}`),
        );
        cell(
          `POST same name at root ${who}`,
          await http(who, 'POST', '/api/files/files', {
            parentPath: 'files',
            filename: 'kr-owner.txt',
            content: `over by ${who}`,
            confirm: true,
          }),
        );
      }
      // upsertFile itself, at the root, in every context.
      let n = 0;
      for (const [ctx, run] of CONTEXTS) {
        n += 1;
        const filename = `kr-lib-${n}.txt`;
        cell(
          `upsertFile root ${ctx}`,
          await answer(() =>
            run(async () => {
              const f = await files.upsertFile({
                ownerId: L.owner,
                parentPath: 'files',
                filename,
                bytes: Buffer.from(`lib ${ctx}`),
              });
              return { filename: f.filename, parentPath: f.parentPath };
            }),
          ),
        );
        cell(
          `row of ${filename}`,
          await x(sql`select (select array_agg(g.workspace_id::text order by g.workspace_id)
                                from item_grants g where g.node_id = n.id) as held
                        from nodes n where n.owner_id = ${L.owner} and n.type = 'file'
                         and n.data->>'filename' = ${filename}`),
        );
      }
    });
  });
  // ── rule-in-query: the any-login routes that left the scope whole ──────
  it('rule-in-query', async () => {
    const bcrypt = (await import('bcryptjs')).default;
    const hash = bcrypt.hashSync('a6b-password', 4);
    await x(sql`update auth.users set password_hash = ${hash} where email like 'a6b-%'`);
    // The assistants assigned: Admin's to adminAll, P's to adminNoUsers (an
    // assistant of a workspace that login is not in).
    await x(sql`update agents set assigned_user_id = ${L.adminAll}, assigned_at = now(), role = 'assistant'
                 where id = ${AG.admin}`);
    await x(sql`update agents set assigned_user_id = ${L.adminNoUsers}, assigned_at = now(), role = 'assistant'
                 where id = ${AG.P}`);
    await x(sql`update agents set role = 'assistant' where id = ${AG.Q}`);
    // Chat history: each login's own turns with the assistants it reaches,
    // and a member's reply with pictures (one it may read, one it may not).
    const FILE_Q = id(501);
    const FILE_ADMIN = id(502);
    names.set(FILE_Q, 'file:Q');
    names.set(FILE_ADMIN, 'file:Admin');
    for (const [fid, title] of [
      [FILE_Q, 'q.png'],
      [FILE_ADMIN, 'admin.png'],
    ] as const) {
      await x(sql`insert into nodes (id, owner_id, type, title, path, data)
                  values (${fid}, ${L.owner}, 'file', ${title}, 'files',
                          ${JSON.stringify({ filename: title, mimeType: 'image/png' })}::jsonb)`);
    }
    await m.withHeads([FILE_Q], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${FILE_Q}`);
      await tx.execute(
        sql`insert into item_grants (node_id, workspace_id, is_home) values (${FILE_Q}, ${W.Q}, true)`,
      );
    });
    const msg = (login: LoginKey, agent: keyof typeof AG, ws: string, dir: string, text: string) =>
      x(sql`insert into assistant_messages (owner_id, agent_id, login_id, workspace_id, direction, text, channel, status)
            values (${L.owner}, ${AG[agent]}, ${L[login]}, ${ws}, ${dir}, ${text}, 'web', 'complete')`);
    await msg('owner', 'admin', adminWs, 'inbound', 'owner asks');
    await msg('owner', 'admin', adminWs, 'outbound', 'owner answered');
    await msg('adminAll', 'admin', adminWs, 'inbound', 'adminAll asks');
    await msg('adminAll', 'admin', adminWs, 'outbound', 'adminAll answered');
    await msg('modP', 'P', W.P, 'inbound', 'modP asks');
    await msg(
      'modP',
      'P',
      W.P,
      'outbound',
      `see ![q](media:${FILE_Q}) and ![a](media:${FILE_ADMIN})`,
    );
    await msg('userQ', 'Q', W.Q, 'outbound', `look ![q](media:${FILE_Q})`);
    await section('rule-in-query', async (cell) => {
      for (const who of LOGINS) {
        cell(`GET /api/auth/whoami ${who}`, await http(who, 'GET', '/api/auth/whoami'));
        cell(`GET /api/v1/whoami ${who}`, await http(who, 'GET', '/api/v1/whoami'));
        cell(`GET /api/shell ${who}`, blank(await http(who, 'GET', '/api/shell')));
        cell(`HEAD /api/shell ${who}`, await http(who, 'HEAD', '/api/shell'));
      }
      // Pending approvals: the badge counts every login's.
      await x(sql`insert into pending_tool_calls (owner_id, tool_slug, args, status, login_id, workspace_id)
                  values (${L.owner}, 'note_create', '{}'::jsonb, 'pending', ${L.adminAll}, ${adminWs}),
                         (${L.owner}, 'note_create', '{}'::jsonb, 'pending', ${L.modP}, ${W.P}),
                         (${L.owner}, 'note_create', '{}'::jsonb, 'pending', null, null)`).catch(
        (e: Error) => cell('pending insert failed', e.message),
      );
      for (const who of LOGINS) {
        cell(`GET /api/shell pending ${who}`, blank(await http(who, 'GET', '/api/shell')));
      }
      // Access keys: make, list, use, revoke.
      const keys = new Map<string, { id: string; secret: string }>();
      for (const who of LOGINS) {
        cell(
          `POST /api/access-keys wrong password ${who}`,
          await http(who, 'POST', '/api/access-keys', {
            name: `k-${who}`,
            access: 'read',
            areas: null,
            expiresInDays: 30,
            password: 'not-it',
          }),
        );
        const made = await http(who, 'POST', '/api/access-keys', {
          name: `k-${who}`,
          access: 'read',
          areas: null,
          expiresInDays: 30,
          password: 'a6b-password',
        });
        const b = made.body as Json;
        if (made.status === 201) {
          keys.set(who, { id: b.id, secret: b.secret });
          names.set(String(b.id).toLowerCase(), `key:${who}`);
        }
        cell(`POST /api/access-keys ${who}`, blank(made));
      }
      // A made key tells its login in its chat (not awaited by the route):
      // wait until those notices have landed, so the chat cells below read
      // them on every run.
      for (let i = 0, last = -1; i < 50; i += 1) {
        const [r] = await x<{ n: number }>(
          sql`select count(*)::int as n from assistant_messages where text like 'A new API key%'`,
        );
        if (r!.n === last) break;
        last = r!.n;
        await new Promise((res) => setTimeout(res, 100));
      }
      for (const who of LOGINS) {
        cell(`GET /api/access-keys ${who}`, await http(who, 'GET', '/api/access-keys'));
      }
      for (const who of LOGINS) {
        const k = keys.get(who);
        if (k) {
          cell(
            `GET /api/v1/whoami key ${who}`,
            await http({ bearer: k.secret }, 'GET', '/api/v1/whoami'),
          );
        }
      }
      // A key's use is stamped after its answer: wait until every stamp has
      // landed, so the lists below read them on every run.
      for (let i = 0; i < 50; i += 1) {
        const [r] = await x<{ n: number }>(
          sql`select count(*)::int as n from access_keys where last_used_at is null`,
        );
        if (r!.n === 0) break;
        await new Promise((res) => setTimeout(res, 100));
      }
      // Revoke: a member another's key (refused), an Admin user a member's,
      // each its own.
      const del = (who: LoginKey, of: LoginKey) => {
        const k = keys.get(of);
        return k ? http(who, 'DELETE', `/api/access-keys/${k.id}`) : Promise.resolve(null);
      };
      cell('DELETE key of=owner by=modP', await del('modP', 'owner'));
      cell('DELETE key of=userQ by=modP', await del('modP', 'userQ'));
      cell('DELETE key of=modP by=adminNoUsers', await del('adminNoUsers', 'modP'));
      cell('DELETE key of=userQ by=userQ', await del('userQ', 'userQ'));
      cell('DELETE key of=userQ by=userQ again', await del('userQ', 'userQ'));
      cell('DELETE key of=outsider by=outsider', await del('outsider', 'outsider'));
      cell('DELETE key of=adminAll by=adminAll', await del('adminAll', 'adminAll'));
      cell(
        'DELETE key unknown by=modP',
        await http('modP', 'DELETE', `/api/access-keys/${id(999)}`),
      );
      for (const who of LOGINS) {
        cell(`GET /api/access-keys after ${who}`, await http(who, 'GET', '/api/access-keys'));
      }
      // The chat bundle: the assigned assistant, the level badge, pictures.
      for (const who of LOGINS) {
        for (const ag of ['admin', 'P', 'Q'] as const) {
          cell(
            `GET /api/assistant/thread ${who} agent=${ag}`,
            await http(who, 'GET', `/api/assistant/thread?agent=a6b-${ag}`),
          );
        }
        cell(`GET /api/assistant/thread ${who}`, await http(who, 'GET', '/api/assistant/thread'));
      }
      // The inbox: read cursors, before and after marking read.
      for (const who of LOGINS) {
        cell(
          `GET /api/assistant/conversations ${who}`,
          await http(who, 'GET', '/api/assistant/conversations'),
        );
        for (const ag of ['admin', 'P', 'Q'] as const) {
          cell(
            `POST /api/assistant/read ${who} agent=${ag}`,
            await http(who, 'POST', '/api/assistant/read', {
              agentSlug: `a6b-${ag}`,
              at: '2030-01-01T00:00:00.000Z',
            }),
          );
        }
        cell(
          `GET /api/assistant/conversations after ${who}`,
          await http(who, 'GET', '/api/assistant/conversations'),
        );
      }
      cell(
        'read cursors',
        (
          await x<{ agent: string; login: string; at: string }>(
            sql`select agent_id::text as agent, login_id::text as login, last_read_at::text as at
                  from assistant_read_cursors where owner_id = ${L.owner}`,
          )
        )
          .map((r) => JSON.stringify(norm(r)))
          .sort(),
      );
      // Transcribe: no STT worker, then one whose provider has no adapter.
      const clip = () => {
        const f = new FormData();
        f.append(
          'audio',
          new Blob([Buffer.from('not really audio')], { type: 'audio/webm' }),
          'a.webm',
        );
        return f;
      };
      for (const who of LOGINS) {
        cell(
          `POST /api/assistant/transcribe no worker ${who}`,
          await http(who, 'POST', '/api/assistant/transcribe', undefined, clip()),
        );
      }
      const ak = await import('@mantle/api-keys');
      const key = await m.asSystem(
        () => ak.setApiKey(L.owner, 'openai', 'a6b stt', 'sk-a6b-not-a-key'),
        'test',
      );
      await x(sql`insert into ai_workers (owner_id, slug, name, kind, provider, model, api_key_id, is_default, enabled)
                  values (${L.owner}, 'a6b-stt', 'stt', 'stt', 'a6b-none', 'm', ${key.id}, true, true)`);
      for (const who of LOGINS) {
        cell(
          `POST /api/assistant/transcribe worker ${who}`,
          await http(who, 'POST', '/api/assistant/transcribe', undefined, clip()),
        );
      }
      // An app's admin-only switches (loginIsAdmin).
      for (const who of LOGINS) {
        const made = await http(who, 'POST', '/api/apps', { name: `app ${who}` });
        const appId = (made.body as Json)?.app?.id ?? (made.body as Json)?.id ?? null;
        if (appId) names.set(String(appId).toLowerCase(), `app:${who}`);
        cell(`POST /api/apps ${who}`, made);
        if (appId) {
          cell(
            `PATCH /api/apps/:id mcpAccess ${who}`,
            await http(who, 'PATCH', `/api/apps/${appId}`, { mcpAccess: true }),
          );
          cell(
            `app row ${who}`,
            await x(sql`select a.author_level, a.author_login_id::text as author, a.mcp_access
                          from apps a where a.node_id = ${appId}`).catch((e: Error) => e.message),
          );
        }
      }
    });
  });
  // ── narrow reads: connectors, contact sharing, file names, export links,
  //    access log names, runs, keyword statistics, the app trash ─────────
  it('narrow-reads', async () => {
    const ea = await import('../../../packages/tools/src/external-access');
    const tables = await import('../../../packages/content/src/tables/shared');
    const runs = await import('@mantle/runs');
    const searchMod = await import('../../../packages/search/src/keyword-query');
    const tools = await import('@mantle/tools');
    // A connector held by P (Write on) and Q (Write off), and one held by
    // no workspace; a tool on each.
    await x(sql`insert into tool_groups (owner_id, slug, name, description, enabled, integration)
                values (${L.owner}, 'a6b-conn', 'A6b connector', 'd', true, '{"mcp":{"url":"http://127.0.0.1:9/mcp"}}'::jsonb),
                       (${L.owner}, 'a6b-lone', 'A6b lone', 'd', true, '{"mcp":{"url":"http://127.0.0.1:9/mcp"}}'::jsonb),
                       (${L.owner}, 'a6b-off', 'A6b off', 'd', false, null)`);
    await x(sql`insert into workspace_resources (workspace_id, type, ref_id, write) values
                (${W.P}, 'connector', 'a6b-conn', true), (${W.Q}, 'connector', 'a6b-conn', false)`);
    // Contacts with sharing on (one locked), one without.
    const C = [id(601), id(602), id(603)];
    C.forEach((c, i) => names.set(c, `contact:${i}`));
    for (const [i, c] of C.entries()) {
      await x(sql`insert into nodes (id, owner_id, type, title, path)
                  values (${c}, ${L.owner}, 'contact', ${`contact ${i}`}, 'contacts')`);
    }
    await x(sql`insert into contact_share_codes (contact_id, owner_id, code_hash, created_at, last_used_at, locked_until)
                values (${C[0]!}, ${L.owner}, 'h0', '2026-01-01', '2026-01-02', null),
                       (${C[1]!}, ${L.owner}, 'h1', '2026-01-03', null, '2999-01-01')`);
    // Files: one in the root, one homed in P, in a P folder.
    await files.ensureFilesRootBranch(L.owner);
    const FN = [id(611), id(612)];
    names.set(FN[0]!, 'file:nr-root');
    names.set(FN[1]!, 'file:nr-p');
    await x(sql`insert into nodes (id, owner_id, type, title, slug, path, data)
                values (${FN[0]!}, ${L.owner}, 'file', 'Taken.txt', 'taken.txt', 'files',
                        '{"filename":"Taken.txt"}'::jsonb),
                       (${FN[1]!}, ${L.owner}, 'file', 'p.txt', 'p.txt', 'files',
                        '{"filename":"p.txt","space_file":true}'::jsonb)`);
    await m.withHeads([FN[1]!], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${FN[1]!}`);
      await tx.execute(
        sql`insert into item_grants (node_id, workspace_id, is_home) values (${FN[1]!}, ${W.P}, true)`,
      );
    });
    // An app with an exported table (homed in P), its access log, and a
    // table no app is bound to.
    const APP = id(621);
    const TBL = id(622);
    const TBL2 = id(623);
    names.set(APP, 'app:nr');
    names.set(TBL, 'table:bound');
    names.set(TBL2, 'table:free');
    await x(sql`insert into nodes (id, owner_id, type, title, path) values
                (${APP}, ${L.owner}, 'app', 'Bound app', 'apps'),
                (${TBL}, ${L.owner}, 'table', 'Bound table', 'tables'),
                (${TBL2}, ${L.owner}, 'table', 'Free table', 'tables')`);
    for (const n of [APP, TBL, TBL2]) {
      await m.withHeads([n], 'update', async (tx) => {
        await tx.execute(sql`delete from item_grants where node_id = ${n}`);
        await tx.execute(
          sql`insert into item_grants (node_id, workspace_id, is_home) values (${n}, ${W.P}, true)`,
        );
      });
    }
    await x(sql`insert into app_table_exports (owner_id, app_node_id, table_node_id, sqlite_table)
                values (${L.owner}, ${APP}, ${TBL}, 'items')`);
    await x(sql`insert into app_access_log (owner_id, app_node_id, actor_id, kind) values
                (${L.owner}, ${APP}, ${L.modP}, 'open'), (${L.owner}, ${APP}, ${L.userQ}, 'open'),
                (${L.owner}, ${APP}, ${L.owner}, 'open')`);
    // Runs: one stamped P, one Admin, one with none.
    const R = [id(631), id(632), id(633)];
    R.forEach((r, i) => names.set(r, `run:${i}`));
    await x(sql`insert into runs (id, owner_id, title, workspace_id) values
                (${R[0]!}, ${L.owner}, 'p run', ${W.P}), (${R[1]!}, ${L.owner}, 'admin run', ${adminWs}),
                (${R[2]!}, ${L.owner}, 'no ws run', null)`);
    // Deleted apps: homed in P, in Q, in no workspace (an old snapshot).
    const GONE = [id(641), id(642), id(643)];
    GONE.forEach((g, i) => names.set(g, `gone:${i}`));
    for (const [i, g] of GONE.entries()) {
      const meta =
        i === 2 ? { title: `gone ${i}` } : { title: `gone ${i}`, homeWs: i === 0 ? W.P : W.Q };
      await x(sql`insert into node_snapshots (owner_id, node_id, node_kind, seq, trigger, actor, code, created_at)
                  values (${L.owner}, ${g}, 'app', 1, 'pre_delete', 'owner', ${JSON.stringify({ meta })}::jsonb,
                          now() - make_interval(mins => ${i}))`);
    }
    // What each context's scope reads, as the definers see it (SCOPE_FACTS:
    // the named changes held to the scope check against it).
    const nameOf = (u: string) => names.get(u.toLowerCase()) ?? u;
    for (const [ctx, run] of CONTEXTS) {
      SCOPE_FACTS.set(
        ctx,
        await run(async () => {
          const [s] = await x2<{ active: boolean }>(
            sql`select "public"."mantle_scope_active"() as active`,
          );
          const seen = await x2<{ id: string }>(
            sql`select id::text as id from nodes where id = any(${m.wsArraySql([APP, ...C])})`,
          );
          return {
            active: s!.active === true,
            reads: new Set(seen.map((r) => nameOf(r.id))),
          };
        }),
      );
    }
    await section('narrow-reads', async (cell) => {
      for (const [ctx, run] of CONTEXTS) {
        const a = (k: string, fn: () => Promise<unknown>) =>
          answer(() => run(fn)).then((v) => cell(`${k} ${ctx}`, v));
        await a('connectorGroupOf conn', () =>
          ea.connectorGroupOf(L.owner, {
            handler: { kind: 'mcp', group: 'a6b-conn', toolName: 't' },
          } as never),
        );
        await a('connectorGroupOf off', () =>
          ea.connectorGroupOf(L.owner, {
            handler: { kind: 'mcp', group: 'a6b-off', toolName: 't' },
          } as never),
        );
        await a('connectorResources conn P,Q,Admin', () =>
          ea.connectorResources(L.owner, 'a6b-conn', [W.P, W.Q, adminWs]),
        );
        await a('connectorOpensBeyondAdmin conn', () =>
          ea.connectorOpensBeyondAdmin(L.owner, 'a6b-conn'),
        );
        await a('connectorOpensBeyondAdmin lone', () =>
          ea.connectorOpensBeyondAdmin(L.owner, 'a6b-lone'),
        );
        await a('appConnectorRefused read', () =>
          ea.appConnectorRefused(L.owner, APP, 'a6b-conn', false),
        );
        await a('appConnectorRefused write', () =>
          ea.appConnectorRefused(L.owner, APP, 'a6b-conn', true),
        );
        for (const who of LOGINS) {
          await a(`loginConnectorRule ${who}`, async () => {
            const rule = await ea.loginConnectorRule(L.owner, L[who]);
            return [rule('a6b-conn', false), rule('a6b-conn', true), rule('a6b-lone', false)];
          });
        }
        await a('contactSharingByContact', async () => [
          ...(await content.contactSharingByContact(L.owner, C, new Date('2026-06-01'))),
        ]);
        await a('fileNameTaken taken.txt', () =>
          files.fileNameTaken(L.owner, 'files', 'taken.txt'),
        );
        await a('fileNameTaken P.TXT', () => files.fileNameTaken(L.owner, 'files', 'P.TXT'));
        await a('fileNameTaken none', () => files.fileNameTaken(L.owner, 'files', 'none.txt'));
        await a('assertTableNotAppBound bound', () => tables.assertTableNotAppBound(TBL));
        await a('assertTableNotAppBound free', () => tables.assertTableNotAppBound(TBL2));
        await a('listAppAccess', async () =>
          (await content.listAppAccess(L.owner, APP)).map((r) => [r.actorId, r.contactName]).sort(),
        );
        for (const [rk, rid] of [
          ['P', R[0]!],
          ['Admin', R[1]!],
          ['none', R[2]!],
        ] as const) {
          await a(`assertRunsCarryScope ${rk}`, () =>
            runs.assertRunsCarryScope([{ type: 'resume', runId: rid, groupId: id(999) } as never]),
          );
        }
        await a('resolveKeywordQuery nodes', () =>
          searchMod.resolveKeywordQuery('taken bound gone zzzunseen', 'nodes'),
        );
        await a('resolveKeywordQuery chunks', () =>
          searchMod.resolveKeywordQuery('taken bound gone zzzunseen', 'content_chunks'),
        );
        await a('app_deleted_list', () =>
          tools
            .getBuiltin('app_deleted_list')!
            .handler({}, { ownerId: L.owner, surface: { kind: 'web', loginId: L.owner } } as never),
        );
      }
    });
  });
  // ── login-telegram: a login's chats, the moderated chats, approval cards,
  //    the replay of a login's own Telegram history ───────────────────────
  it('telegram', async () => {
    const tools = await import('@mantle/tools');
    const at = await import('@/lib/agent-telegram');
    // P's assistant has a bot; its chats: modP's and userQ's (allowed), a
    // pending one, a denied one. Admin's assistant has a bot with the
    // owner's chat.
    const CH = { P: id(701), admin: id(702) };
    const BOT = { P: id(711), admin: id(712) };
    const CHAT = {
      modP: id(721),
      userQ: id(722),
      pending: id(723),
      denied: id(724),
      owner: id(725),
    };
    for (const [k, v] of Object.entries(BOT)) names.set(v, `bot:${k}`);
    for (const [k, v] of Object.entries(CHAT)) names.set(v, `chat:${k}`);
    for (const k of ['P', 'admin'] as const) {
      await x(sql`insert into channels (id, owner_id, agent_id, type, display_name, credentials_enc)
                  values (${CH[k]}, ${L.owner}, ${AG[k]}, 'telegram', ${`${k} bot`}, decode('00', 'hex'))`);
      await x(sql`insert into telegram_accounts (id, user_id, bot_username, branch_path, channel_id)
                  values (${BOT[k]}, ${L.owner}, ${`a6b_${k}_bot`}, 'telegram', ${CH[k]})`);
    }
    const chat = (cid: string, bot: string, tid: string, status: string, login: string | null) =>
      x(sql`insert into telegram_chats (id, account_id, user_id, telegram_chat_id, chat_type, title,
                                        allowlist_status, login_id, last_message_at, pairing_code)
            values (${cid}, ${bot}, ${L.owner}, ${tid}, 'private', ${`chat ${tid}`},
                    ${status}::telegram_allowlist_status, ${login},
                    now() - make_interval(mins => ${Number(tid)}),
                    ${status === 'pending' ? `code${tid}` : null})`);
    await chat(CHAT.modP, BOT.P, '101', 'allowed', L.modP);
    await chat(CHAT.userQ, BOT.P, '102', 'allowed', L.userQ);
    await chat(CHAT.pending, BOT.P, '103', 'pending', null);
    await chat(CHAT.denied, BOT.P, '104', 'denied', null);
    await chat(CHAT.owner, BOT.admin, '105', 'allowed', L.owner);
    // Messages (each on a node of its chat's login): the owner's, adminAll's
    // (on the Admin bot, a chat since paired away), modP's.
    const msg = async (
      n: number,
      chatId: string,
      bot: string,
      login: string | null,
      text: string,
    ) => {
      const nid = id(730 + n);
      names.set(nid, `tgnode:${n}`);
      await x(sql`insert into nodes (id, owner_id, type, title, path, login_id)
                  values (${nid}, ${L.owner}, 'note', ${`tg ${n}`}, 'telegram', ${login})`);
      await x(sql`insert into telegram_messages (node_id, account_id, chat_id, text, sent_at, direction, from_name)
                  values (${nid}, ${bot}, ${chatId}, ${text}, ${`2026-05-0${n} 10:00+00`}::timestamptz, 'inbound', 'Pat')`);
    };
    await msg(1, CHAT.owner, BOT.admin, L.owner, 'owner says hi');
    await msg(2, CHAT.owner, BOT.admin, L.adminAll, 'adminAll said this once');
    await msg(3, CHAT.modP, BOT.P, L.modP, 'modP says hi');
    await msg(4, CHAT.owner, BOT.admin, null, 'from before logins');
    // Pending calls: adminAll's, modP's, an elevated one of modP's, one with
    // no login.
    const PEND = { adminAll: id(741), modP: id(742), elevated: id(743), none: id(744) };
    for (const [k, v] of Object.entries(PEND)) names.set(v, `pending:${k}`);
    await x(sql`insert into pending_tool_calls (id, owner_id, tool_slug, args, status, login_id, workspace_id, elevated)
                values (${PEND.adminAll}, ${L.owner}, 'note_create', '{}'::jsonb, 'pending', ${L.adminAll}, ${adminWs}, null),
                       (${PEND.modP}, ${L.owner}, 'note_create', '{}'::jsonb, 'pending', ${L.modP}, ${W.P}, null),
                       (${PEND.elevated}, ${L.owner}, 'note_create', '{}'::jsonb, 'pending', ${L.modP}, ${W.P},
                        '{"elevated":true,"reason":"x"}'::jsonb),
                       (${PEND.none}, ${L.owner}, 'note_create', '{}'::jsonb, 'pending', null, null, null)`);
    // adminAll pairs a chat on the Admin bot, so its card has somewhere to go.
    await chat(id(726), BOT.admin, '106', 'allowed', L.adminAll);
    names.set(id(726), 'chat:adminAll');
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.map((v) => (v instanceof Error ? v.message : String(v))).join(' '));
    });
    try {
      await section('telegram', async (cell) => {
        for (const who of LOGINS) {
          cell(
            `GET /api/telegram/my-chats ${who}`,
            await http(who, 'GET', '/api/telegram/my-chats'),
          );
          cell(
            `GET /api/telegram/moderated-chats ${who}`,
            await http(who, 'GET', '/api/telegram/moderated-chats'),
          );
          cell(
            `GET /api/agents/:P/telegram ${who}`,
            await http(who, 'GET', `/api/agents/${AG.P}/telegram`),
          );
        }
        for (const [ctx, run] of CONTEXTS) {
          for (const who of LOGINS) {
            cell(
              `listMyTelegramChats ${who} ${ctx}`,
              await answer(() => run(() => at.listMyTelegramChats(L.owner, L[who]))),
            );
          }
          for (const who of ['owner', 'adminAll', 'adminNoUsers', 'modP', 'userQ'] as const) {
            cell(
              `listModeratedTelegramChats ${who} ${ctx}`,
              await answer(() => run(() => at.listModeratedTelegramChats(L.owner, L[who]))),
            );
          }
          for (const [pk, pid] of Object.entries(PEND)) {
            tg.sent.length = 0;
            errors.length = 0;
            const done = await answer(() =>
              run(() =>
                tools.notifyPendingCreated({
                  ownerId: L.owner,
                  pendingId: pid,
                  toolSlug: 'note_create',
                  args: { title: 't' },
                }),
              ),
            );
            cell(`notifyPendingCreated ${pk} ${ctx}`, {
              done,
              sent: [...tg.sent],
              errors: errors.filter((e) => e.includes('[pending:notify]')),
            });
          }
          for (const who of ['owner', 'adminAll', 'modP'] as const) {
            cell(
              `replay_window telegram asker=${who} ${ctx}`,
              await answer(() =>
                run(() =>
                  tools
                    .getBuiltin('replay_window')!
                    .handler({ from: '2026-05-01', to: '2026-05-31', surface: 'telegram' }, {
                      ownerId: L.owner,
                      surface: { kind: 'web', loginId: L[who] },
                    } as never),
                ),
              ),
            );
          }
        }
      });
    } finally {
      spy.mockRestore();
    }
  });

  // ── client-sourced: the check (namesClientSourced, clientSourcedAmong,
  //    the corpus map), the conversation's mark, the marks a turn and an
  //    export write, and the write rule of a marked turn ──────────────────
  it('client-sourced', async () => {
    const cs = await import('../../../packages/tools/src/client-sourced');
    const rules = await import('../../../packages/tools/src/client-sourced-rules');
    const ts = await import('@mantle/db/test-support');
    const exportsMod = await import('@mantle/content/app-table-exports');
    const OTHER = id(801);
    const FC = id(802);
    const CW = id(803);
    names.set(OTHER, 'brain:other');
    names.set(FC, 'login:formerClient');
    names.set(CW, 'ws:Clients');
    await x(sql`insert into auth.users (id, email, password_hash, role) values
                (${OTHER}, 'a6b-other@example.invalid', 'x', 'admin')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${OTHER}, 'brain', ${OTHER})`);
    // A former client (0272 leaves a disabled member row and its archive
    // row), a user of the Clients workspace.
    await x(sql`insert into auth.users (id, email, password_hash, role, disabled_at)
                values (${FC}, 'a6b-fc@example.invalid', 'x', 'member', now())`);
    await x(sql`insert into archive_client_logins (login_id, email, created_at, session_epoch)
                select id, email, created_at, session_epoch from auth.users where id = ${FC}`);
    await x(sql`insert into workspaces (id, owner_id, name) values (${CW}, ${L.owner}, 'Clients')`);
    await x(
      sql`insert into workspace_users (workspace_id, login_id, moderator) values (${CW}, ${FC}, false)`,
    );
    const N = {
      clientTask: id(811),
      plainTask: id(812),
      otherClientTask: id(813),
      clientItem: id(814),
      copied: id(815),
      clientsPage: id(816),
      linkedPage: id(817),
      servedPage: id(818),
      pPage: id(819),
      sharedFolder: id(820),
      clientsApp: id(821),
      clientsAppTable: id(822),
      writtenApp: id(823),
      writtenAppTable: id(824),
      teamApp: id(825),
      teamAppTable: id(826),
      exposedTableApp: id(827),
      old: id(828),
      writtenGone: id(829),
      teamGone: id(830),
    };
    for (const [k, v] of Object.entries(N)) names.set(v, `cs:${k}`);
    const data = (source: string | null) => JSON.stringify(source ? { source } : {});
    await x(sql`insert into nodes (id, owner_id, type, title, path, data) values
      (${N.clientTask}, ${L.owner}, 'task', 'client request', 'tasks', ${data('client-request')}::jsonb),
      (${N.plainTask}, ${L.owner}, 'task', 'plain', 'tasks', ${data(null)}::jsonb),
      (${N.otherClientTask}, ${OTHER}, 'task', 'other brain', 'tasks', ${data('client-request')}::jsonb),
      (${N.clientItem}, ${L.owner}, 'page', 'from a client', 'pages', '{}'::jsonb),
      (${N.copied}, ${L.owner}, 'page', 'a marked copy', 'pages', '{}'::jsonb),
      (${N.clientsPage}, ${L.owner}, 'page', 'clients read it', 'pages', '{}'::jsonb),
      (${N.linkedPage}, ${L.owner}, 'page', 'an open link', 'pages', '{}'::jsonb),
      (${N.servedPage}, ${L.owner}, 'page', 'served by a link', 'pages', '{}'::jsonb),
      (${N.pPage}, ${L.owner}, 'page', 'P only', 'pages', '{}'::jsonb),
      (${N.clientsApp}, ${L.owner}, 'app', 'clients app', 'apps', '{}'::jsonb),
      (${N.clientsAppTable}, ${L.owner}, 'table', 'clients export', 'tables', '{}'::jsonb),
      (${N.writtenApp}, ${L.owner}, 'app', 'written app', 'apps', '{}'::jsonb),
      (${N.writtenAppTable}, ${L.owner}, 'table', 'written export', 'tables', '{}'::jsonb),
      (${N.teamApp}, ${L.owner}, 'app', 'team app', 'apps', '{}'::jsonb),
      (${N.teamAppTable}, ${L.owner}, 'table', 'team export', 'tables', '{}'::jsonb),
      (${N.exposedTableApp}, ${L.owner}, 'app', 'exports a clients table', 'apps', '{}'::jsonb),
      (${N.old}, ${L.owner}, 'note', 'old', 'notes', '{}'::jsonb),
      (${N.writtenGone}, ${L.owner}, 'table', 'written gone', 'tables', '{}'::jsonb),
      (${N.teamGone}, ${L.owner}, 'table', 'team gone', 'tables', '{}'::jsonb)`);
    await x(sql`update nodes set created_at = now() - interval '1 day' where id = ${N.old}`);
    await x(sql`insert into nodes (id, owner_id, type, title, path) values
      (${N.sharedFolder}, ${L.owner}, 'branch', 'shared', 'pages.a6b_shared')`);
    // Who holds what: Clients holds its page, the shared folder and its
    // app; P the rest.
    const holders: Array<[string, string]> = [
      [N.clientsPage, CW],
      [N.sharedFolder, CW],
      [N.clientsApp, CW],
      [N.clientsAppTable, adminWs],
      [N.writtenApp, W.P],
      [N.writtenAppTable, W.P],
      [N.teamApp, W.P],
      [N.teamAppTable, W.P],
      [N.exposedTableApp, W.P],
      [N.linkedPage, W.P],
      [N.servedPage, W.P],
      [N.pPage, W.P],
      [N.clientItem, W.P],
      [N.copied, W.P],
      [N.writtenGone, W.P],
      [N.teamGone, W.P],
    ];
    for (const [n, w] of holders) {
      await m.withHeads([n], 'update', async (tx) => {
        await tx.execute(sql`delete from item_grants where node_id = ${n}`);
        await tx.execute(
          sql`insert into item_grants (node_id, workspace_id, is_home) values (${n}, ${w}, true)`,
        );
      });
    }
    // An item a client wrote (stamped directly: no login is a client now).
    await ts.asMigrator(scratch!.url, async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into space_items (node_id, author_login_id, review_state, author_role)
        values (${N.clientItem}, ${FC}, 'accepted', 'client')`;
    });
    await x(sql`insert into client_sourced_nodes (node_id, owner_id, via)
                values (${N.copied}, ${L.owner}, 'a6b')`);
    // An open link on one page, serving another.
    await x(sql`insert into shares (token, owner_id, node_id, node_type, settings) values
      ('a6b-cs-link', ${L.owner}, ${N.linkedPage}, 'page',
       ${JSON.stringify({ served: [N.servedPage] })}::jsonb)`);
    // The exports: the Clients app's, a written app's, a team app's, and an
    // app exporting the Clients-held page's twin (a table Clients reads).
    await x(sql`insert into app_databases (owner_id, app_node_id, storage_path, client_written_at)
                values (${L.owner}, ${N.writtenApp}, 'a6b/written.sqlite', now())`);
    await x(sql`insert into app_table_exports (owner_id, app_node_id, sqlite_table, table_node_id) values
      (${L.owner}, ${N.clientsApp}, 'rows', ${N.clientsAppTable}),
      (${L.owner}, ${N.writtenApp}, 'rows', ${N.writtenAppTable}),
      (${L.owner}, ${N.teamApp}, 'rows', ${N.teamAppTable}),
      (${L.owner}, ${N.exposedTableApp}, 'rows', ${N.clientsPage})`);
    // An assistant clients talk to (the Clients workspace's), with a group.
    const CA = id(831);
    names.set(CA, 'agent:clients');
    await x(sql`insert into tool_groups (owner_id, slug, name, description, enabled, tool_slugs)
                values (${L.owner}, 'a6b-cs-group', 'cs group', 'd', true, '{a6b_cs_tool}'),
                       (${L.owner}, 'a6b-cs-plain', 'plain group', 'd', true, '{a6b_plain_tool}')`);
    await x(sql`insert into agents (id, owner_id, slug, name, model, system_prompt, workspace_id, tool_group_slugs)
                values (${CA}, ${L.owner}, 'a6b-cs-clients', 'clients assistant', 'test/model', 'p', ${CW},
                        '{a6b-cs-group}')`);
    // A conversation marked now and one marked 25 hours ago.
    await x(sql`insert into conversation_taints (owner_id, conversation_key, via, tainted_at) values
      (${L.owner}, 'a6b:marked', 'task_get', now()),
      (${L.owner}, 'a6b:stale', 'task_get', now() - interval '25 hours')`);

    const IDS = Object.entries({
      clientTask: N.clientTask,
      plainTask: N.plainTask,
      otherClientTask: N.otherClientTask,
      formerClient: FC,
      clientItem: N.clientItem,
      copied: N.copied,
      clientsAppTable: N.clientsAppTable,
      writtenAppTable: N.writtenAppTable,
      teamAppTable: N.teamAppTable,
      pPage: N.pPage,
      unknown: id(899),
    });
    const RULE = {
      kind: 'write',
      nodes: ['n'],
      apps: ['a'],
      paths: ['p'],
      agents: ['ag'],
      groups: ['g'],
      tools: ['t'],
    } as const;
    const VERDICTS: Array<[string, Record<string, unknown>]> = [
      ['clientsPage', { n: N.clientsPage }],
      ['clientsPage upper', { n: N.clientsPage.toUpperCase() }],
      ['linkedPage', { n: N.linkedPage }],
      ['servedPage', { n: N.servedPage }],
      ['pPage twice', { n: [N.pPage, N.pPage] }],
      ['unknown', { n: id(899) }],
      ['otherBrainTask', { n: N.otherClientTask }],
      ['clientsApp', { a: N.clientsApp }],
      ['teamApp', { a: N.teamApp }],
      ['exposedTableApp', { a: N.exposedTableApp }],
      ['shared folder below', { p: 'pages.a6b_shared.sub' }],
      ['shared folder itself', { p: 'pages.a6b_shared' }],
      ['plain path', { p: 'pages.elsewhere' }],
      ['bad path', { p: 'not a path!' }],
      ['clients agent', { ag: 'a6b-cs-clients' }],
      ['P agent', { ag: 'a6b-P' }],
      ['clients group', { g: 'a6b-cs-group' }],
      ['plain group', { g: 'a6b-cs-plain' }],
      ['clients tool', { t: 'a6b_cs_tool' }],
      ['plain tool', { t: 'a6b_plain_tool' }],
      ['pPage and clients agent', { n: N.pPage, ag: 'a6b-cs-clients' }],
    ];
    let fresh = 900;
    await section('client-sourced', async (cell) => {
      for (const [ctx, run] of CONTEXTS) {
        const a = (k: string, fn: () => Promise<unknown>) =>
          answer(() => run(fn)).then((v) => cell(`${k} ${ctx}`, v));
        for (const [k, v] of IDS) {
          await a(`namesClientSourced ${k}`, () => cs.namesClientSourced(L.owner, [v]));
        }
        await a('namesClientSourced other brain', () =>
          cs.namesClientSourced(OTHER, [N.otherClientTask]),
        );
        await a('clientSourcedAmong all', async () =>
          [
            ...(await cs.clientSourcedAmong(
              L.owner,
              IDS.map(([, v]) => v),
            )),
          ].sort(),
        );
        await a('withoutClientSourced all', async () =>
          (
            await cs.withoutClientSourced(
              L.owner,
              IDS.map(([, v]) => ({ id: v })),
            )
          ).map((r) => r.id),
        );
        for (const key of ['a6b:marked', 'a6b:stale', 'a6b:none']) {
          await a(`loadConversationTaint ${key}`, () => cs.loadConversationTaint(L.owner, key));
        }
        await a('loadConversationTaint other brain', () =>
          cs.loadConversationTaint(OTHER, 'a6b:marked'),
        );
        // The conversation's mark kept by a read (taintFromText), then read
        // back on the system pool and cleared.
        const key = `a6b:keep:${ctx}`;
        await a('taintFromText keeps', async () => {
          const taint = { clientSourced: false, conversation: { ownerId: L.owner, key } };
          await cs.taintFromText(taint, L.owner, `see ${N.clientTask}`, 'task_get');
          return taint;
        });
        cell(
          `taintFromText kept ${ctx}`,
          await x(sql`select via from conversation_taints where conversation_key = ${key}`),
        );
        await x(sql`delete from conversation_taints where conversation_key = ${key}`);
        // A node a marked turn just made (and an old one in the output).
        const made = id(fresh++);
        names.set(made, 'cs:made');
        await x(sql`insert into nodes (id, owner_id, type, title, path)
                    values (${made}, ${L.owner}, 'note', 'made', 'notes')`);
        await a('markCreatedClientSourced', () =>
          cs.markCreatedClientSourced(L.owner, `${made} ${N.old}`, 1000, 'task_get'),
        );
        cell(
          `markCreatedClientSourced marked ${ctx}`,
          await x(sql`select node_id::text as id, via from client_sourced_nodes
                       where node_id in (${made}, ${N.old}) order by 1`),
        );
        await x(sql`delete from client_sourced_nodes where node_id in (${made}, ${N.old})`);
        await x(sql`delete from nodes where id = ${made}`);
        for (const [k, input] of VERDICTS) {
          await a(`writeVerdict ${k}`, () =>
            rules.writeVerdict(L.owner, RULE, input).catch(() => 'threw'),
          );
        }
        // The export link's mark (removeAppTableExport): a written app's
        // Table keeps the mark, a team app's does not.
        for (const [k, app, tbl] of [
          ['written', N.writtenApp, N.writtenGone],
          ['team', N.teamApp, N.teamGone],
        ] as const) {
          await x(sql`insert into app_table_exports (owner_id, app_node_id, sqlite_table, table_node_id)
                      values (${L.owner}, ${app}, 'gone', ${tbl})`);
          await a(`removeAppTableExport ${k}`, () =>
            exportsMod.removeAppTableExport(L.owner, app, 'gone'),
          );
          cell(
            `removeAppTableExport ${k} marked ${ctx}`,
            await x(sql`select via from client_sourced_nodes where node_id = ${tbl}`),
          );
          await x(sql`delete from client_sourced_nodes where node_id = ${tbl}`);
          await x(
            sql`delete from app_table_exports where app_node_id = ${app} and sqlite_table = 'gone'`,
          );
        }
      }
    });
  });

  // ── heartbeat-context: a turn's own open heartbeats (the responder's
  //    awareness block and its tool list) ─────────────────────────────────
  it('heartbeat-context', async () => {
    const tick = await import('../../../packages/runtime/src/heartbeats/tick');
    const HB: Array<
      [string, string | null, string, Record<string, unknown>, Record<string, unknown>]
    > = [
      ['anchor-null', null, 'active', { expecting_reply: true }, { kind: 'web' }],
      ['anchor-id', L.owner, 'active', {}, { kind: 'telegram', chat_id: 'c1' }],
      ['modP', L.modP, 'active', { expecting_reply: true }, { kind: 'web' }],
      ['modP-tg', L.modP, 'active', { expecting_reply: true }, { kind: 'telegram', chat_id: 'c2' }],
      ['userQ', L.userQ, 'active', {}, { kind: 'web' }],
      [
        'adminAll',
        L.adminAll,
        'active',
        { expecting_reply: true },
        { kind: 'telegram', chat_id: 'c1' },
      ],
      ['paused', null, 'paused', { expecting_reply: true }, { kind: 'web' }],
    ];
    for (const [slug, by, status, state, surface] of HB) {
      await x(sql`insert into heartbeats (owner_id, slug, name, agent_slug, skill_slug, schedule_kind,
                                          schedule, surface, state, status, created_by)
                  values (${L.owner}, ${`a6b-hb-${slug}`}, ${`hb ${slug}`}, 'a6b-admin', 'skill', 'once',
                          '{}'::jsonb, ${JSON.stringify(surface)}::jsonb, ${JSON.stringify(state)}::jsonb,
                          ${status}::heartbeat_status, ${by})`);
    }
    await section('heartbeat-context', async (cell) => {
      for (const [ctx, run] of CONTEXTS) {
        const a = (k: string, fn: () => Promise<unknown>) =>
          answer(() => run(fn)).then((v) => cell(`${k} ${ctx}`, v));
        for (const [sk, surface] of [
          ['web', { kind: 'web' }],
          ['tg c1', { kind: 'telegram', chatId: 'c1' }],
          ['tg c2', { kind: 'telegram', chatId: 'c2' }],
        ] as const) {
          await a(`openHeartbeatsForSurface ${sk}`, async () =>
            (await tick.openHeartbeatsForSurface(L.owner, surface)).map((h) => h.slug).sort(),
          );
          await a(`hasActiveHeartbeatsOnSurface ${sk}`, () =>
            tick.hasActiveHeartbeatsOnSurface(L.owner, surface),
          );
        }
      }
    });
  });

  // ── workspace-create: a login makes a workspace (the route and the
  //    library in each request context) ──────────────────────────────────
  it('workspace-create', async () => {
    const wsLib = await import('../lib/workspaces');
    const callerOf = (who: LoginKey) =>
      ({
        kind: isAdmin(who) ? 'admin' : 'member',
        loginId: L[who],
        anchorId: L.owner,
        user: null,
      }) as Parameters<typeof wsLib.createWorkspace>[0];
    /** The workspace made under `name`: its row, its users, its events,
     *  named for the cells. */
    const made = async (name: string, label: string) => {
      const ws = await x<{ id: string; created_by: string | null; description: string }>(
        sql`select id::text as id, created_by::text as created_by, description
              from workspaces where owner_id = ${L.owner} and name = ${name} order by created_at`,
      );
      ws.forEach((w, i) => names.set(w.id, `ws:${label}${i ? `#${i}` : ''}`));
      const ids = ws.map((w) => w.id);
      return {
        ws: ws.map(({ created_by, description }) => ({ created_by, description })),
        users: ids.length
          ? await x(sql`select login_id::text as login, moderator, added_by::text as added_by
                          from workspace_users where workspace_id = any(${`{${ids.join(',')}}`}::uuid[])
                         order by 1`)
          : [],
        events: ids.length
          ? await x(sql`select actor_id::text as actor, action, subject from workspace_events
                         where workspace_id = any(${`{${ids.join(',')}}`}::uuid[]) order by at`)
          : [],
      };
    };
    await section('workspace-create', async (cell) => {
      for (const who of LOGINS) {
        const name = `a6b-new-${who}`;
        const res = await http(who, 'POST', '/api/workspaces', { name, description: 'd' });
        const rows = await made(name, `new-${who}`);
        cell(`POST /api/workspaces ${who}`, { res, rows });
        cell(
          `POST /api/workspaces Admin ${who}`,
          await http(who, 'POST', '/api/workspaces', { name: 'Admin' }),
        );
      }
      for (const [ctx, run] of CONTEXTS) {
        const who = /^(read|write):(\w+)$/.exec(ctx)?.[2] as LoginKey | undefined;
        if (!who) continue;
        const name = `a6b-lib-${ctx}`;
        const res = await answer(() =>
          run(() => wsLib.createWorkspace(callerOf(who), { name, description: 'lib' })),
        );
        const rows = await made(name, `lib-${ctx}`);
        cell(`createWorkspace ${ctx}`, { res, rows });
      }
    });
  });
});
