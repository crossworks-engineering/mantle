/**
 * The A8 cells that fail today (the database, or a way in, gives another
 * answer than the guide), each a finding for the owner to decide: the cell's
 * name (a8-grid.ts cellName; a surface cell's name starts with its surface),
 * the finding it belongs to, and a piece of the reason it fails with. A
 * listed cell is known only while it fails for that reason: one that fails
 * for another reason fails the run like an unlisted one. A8 is test code
 * only: a finding is never fixed here. The grid and the surface cells fail
 * on a failure not listed, and on a listed one that passes (the list only
 * shrinks). docs/actors.md, "A8 matrix", names each finding.
 */
import {
  GUIDE_ACTIONS,
  GUIDE_PLACEMENTS,
  GUIDE_WORKSPACE_KINDS,
  expectedAccess,
} from './guide-oracle';

/** F1. /api/v1 refuses a key of a login outside Admin: 403 `member-login`
 *  (server/web/lib/api-v1.ts: "The v1 routes past whoami are admin routes").
 *  The guide: "A key acts as the login that made it, as that login is now.
 *  Its access ... and its areas only narrow that login", and an API only key
 *  "keeps working on /api/v1". Expected: the item read; actual: 403. The
 *  plan's D3 (v1 answers as its base route) is the pending decision. */
const F1 = 'F1 /api/v1 refuses member keys (guide: a key acts as its login)';

/** F2. A raw runtime or database text in a turn's reply. A workspace
 *  assistant's turn (any workspace but Admin) cannot write an item its user
 *  may change by hand: the web turn, the team turn, Telegram, a run item and
 *  a recipe step. The turn scope of such an assistant has no write path
 *  (agent-viewer.ts: only the Admin turn enters with writes), so the write
 *  reaches the workspace role and fails. The guide: "It writes only for a
 *  user who could do it by hand: a Moderator of the home, or a grant with
 *  Write on". Expected: the edit or delete made; actual: refused with a raw
 *  text ("Failed query: update nodes ...", "withSystemTx: only outside a
 *  viewer scope ..."), a crash where the mapper's words belong. The same raw
 *  text answers a write the turn may not make (a deny cell): the right
 *  answer, in the wrong words. */
const F2 = 'F2 a workspace assistant turn cannot write (raw error text)';

/** F4. An Admin user's write request runs on the system pool with its scope
 *  on the transaction (W6a M1, until A4 puts its reads in the scope:
 *  withSystemTx's systemPoolTx), where the database checks a move, a create
 *  in a folder, a delete and a grant change against that scope, and nothing
 *  else: an edit, a draft edit, a public link and an app's data write on an
 *  item outside Admin are made (the `login@system` cells). Its rights are
 *  checked in TypeScript only (the gate's itemWriteGate). The guide: "Read
 *  the item: to be a user of a workspace it is granted to"; "Being an Admin
 *  user is management, not reading". A second line the owner may want; the
 *  same writes on the write role are refused (the `login` cells pass). */
const F4 = 'F4 an Admin write request on the system pool: edits not held to its scope';

/** F5. The Moderator of an app's home deletes the app: the database lets
 *  it (by hand and in a turn), and so do DELETE /api/apps/:id (an
 *  owner-side route) and app_delete over MCP (an MCP connection is an owner
 *  surface to ownerOnlyRefusal). The owner's decision of 2026-10-15 (plan
 *  v2 section 32, F3 revised): the owner and Admin users delete an app, its
 *  home Moderator may not, on any surface; the database gets the rule in a
 *  later product change. */
const F5 = 'F5 the home Moderator deletes an app (owner and Admin users only, plan s32 F3 revised)';

/** F6. A peer acting as its login, Write on, may not change an item others
 *  read (packages/tools/src/key-shared-content.ts: "this item is shared, so
 *  a peer cannot change its content"; access matrix T3). The guide's
 *  "Linked brains": a peer with Acts as "gets the MCP surface as that login,
 *  as the login is now", narrowed by its Write switch and its risky tools
 *  only. A rule the product has and the guide does not name (every fixture
 *  item is read by W and R, and has an open link). */
const F6 = 'F6 a peer may not edit a shared item (a rule the guide does not name)';

/** F10. app_delete refuses an Admin user's run item ("owner-side tool:
 *  not available here": a run's caller is no owner surface to
 *  ownerOnlyRefusal), the owner's own run too. The owner's decision of
 *  2026-10-15 (plan s32, F3 revised): the owner and Admin users delete an
 *  app. A recipe step cannot call it for anyone (it waits for approval),
 *  which the cells count apart, not as a refusal. */
const F10 = 'F10 app_delete refuses an Admin user’s run item (owner decision 2026-10-15)';

/** F9. A contact share's write is named system work on the system pool
 *  (docs/actors.md: "its app's data, when the share allows it"), so the
 *  database holds a statement it sends to nothing but a snapshot copy's
 *  read-only rule: an edit, a draft, a delete, a move, a grant change, a
 *  link and a create of any item are made. Only the /s broker holds it, by
 *  sending none but its app's data (the contact-share surface cells pass).
 *  The guide: a contact share writes only its app's data. */
const F9 = 'F9 a contact share’s write on the system pool: not held to its app’s data';

/** The actor check modes the surface cells run in (docs/update-prod.md:
 *  off, the fleet's default; warn; on). */
export type CheckMode = 'off' | 'warn' | 'on';
export const CHECK_MODES: readonly CheckMode[] = ['off', 'warn', 'on'];

export type KnownFailure = {
  /** The finding (F1, F2, ...). */
  finding: string;
  /** A piece of the cell's failure reason, as the run prints it. */
  reason: string;
  /** A surface cell: the modes it fails in (all three when not given). */
  modes?: readonly CheckMode[];
};

const MEMBER_LOGIN = '"reason":"member-login"';
const RAW_UPDATE = 'Failed query: update "nodes"';
const RAW_SYSTEM_TX = 'withSystemTx: only outside a viewer scope';
const RAW_SNAPSHOT = 'Failed query: insert into "node_snapshots"';
const GONE = 'changed (gone), the oracle denies';
const APP_DELETED = 'changed, the oracle denies';
const known = (finding: string, reason: string, modes?: readonly CheckMode[]): KnownFailure =>
  modes ? { finding, reason, modes } : { finding, reason };

/** F4's cells: each Admin user's edit, link, draft edit and app data write
 *  of an item outside Admin (at its kind's root and in its folder; a
 *  snapshot copy refuses them all), on the system pool. */
function adminSystemPoolEdits(): Record<string, KnownFailure> {
  // The kinds and their actions as the oracle reads the guide (no list of
  // kinds of its own): each one the oracle answers for the item outside Admin.
  const out: Record<string, KnownFailure> = {};
  for (const role of ['owner', 'admin'] as const) {
    for (const placement of ['root', 'folder'] as const) {
      for (const kind of GUIDE_WORKSPACE_KINDS) {
        for (const action of ['edit', 'link', 'editDraft', 'appData'] as const) {
          const want = expectedAccess(
            { surface: 'sql', placement, actor: 'login' },
            role,
            kind,
            action,
          );
          if ('na' in want) continue;
          out[`login@system/${role} ${action} ${kind} @${placement}`] = known(F4, 'changed ({');
        }
      }
    }
  }
  return out;
}

/** F9's cells: each write a contact share with Can write may not make,
 *  as the oracle reads the guide, but those a snapshot copy refuses to
 *  everyone (update-prod.md: its author may delete it). */
function contactSystemPoolWrites(): Record<string, KnownFailure> {
  const copyRefuses = ['edit', 'editDraft', 'move', 'grantAdd', 'link'];
  const out: Record<string, KnownFailure> = {};
  for (const kind of GUIDE_WORKSPACE_KINDS) {
    for (const placement of GUIDE_PLACEMENTS) {
      for (const action of GUIDE_ACTIONS) {
        const want = expectedAccess(
          { surface: 'sql', placement, actor: 'contact-rw' },
          null,
          kind,
          action,
        );
        if ('na' in want || want.allow) continue;
        if (placement === 'snapshot' && copyRefuses.includes(action)) continue;
        out[`contact-rw/- ${action} ${kind} @${placement}`] = known(F9, 'changed (');
      }
    }
  }
  return out;
}

export const KNOWN_FAILURES: Readonly<Record<string, KnownFailure>> = {
  // The grid (SQL).
  ...adminSystemPoolEdits(),
  ...contactSystemPoolWrites(),
  'login/homeModerator delete app @folder': known(F5, GONE),
  'login/homeModerator delete app @root': known(F5, GONE),
  'turn/homeModerator delete app @folder': known(F5, GONE),
  'turn/homeModerator delete app @root': known(F5, GONE),
  // The surface cells (all three check modes unless named).
  'api-v1 login/homeModerator read page @root': known(F1, MEMBER_LOGIN),
  'api-v1 login/homeModerator read table @folder': known(F1, MEMBER_LOGIN),
  'api-v1 login/readGrant read file @folder': known(F1, MEMBER_LOGIN),
  'api-v1 login/readGrant read note @folder': known(F1, MEMBER_LOGIN),
  'api-v1 login/readGrant read table @root': known(F1, MEMBER_LOGIN),
  'api-v1 login/readGrant read task @folder': known(F1, MEMBER_LOGIN),
  'api-v1 login/readGrant read task @root': known(F1, MEMBER_LOGIN),
  'api-v1 login/writeGrant read file @root': known(F1, MEMBER_LOGIN),
  'api-v1 login/writeGrant read note @root': known(F1, MEMBER_LOGIN),
  'api-v1 login/writeGrant read page @folder': known(F1, MEMBER_LOGIN),
  'api-v1 login/writeGrant read page @root': known(F1, MEMBER_LOGIN),
  'api-v1 login/writeGrant read page @snapshot': known(F1, MEMBER_LOGIN),
  'api-v1 login/writeGrant read task @root': known(F1, MEMBER_LOGIN),
  'heartbeat assistant/- edit formula @folder': known(F2, RAW_UPDATE),
  'heartbeat assistant/- edit task @root': known(F2, RAW_UPDATE),
  'recipe turn/homeModerator edit formula @folder': known(F2, RAW_UPDATE),
  'recipe turn/writeGrant edit event @folder': known(F2, RAW_UPDATE),
  'run turn/homeModerator delete event @folder': known(F2, RAW_SYSTEM_TX),
  'run turn/homeModerator delete formula @root': known(F2, RAW_SYSTEM_TX),
  'run turn/homeModerator edit formula @root': known(F2, RAW_UPDATE),
  'run turn/writeGrant edit note @root': known(F2, RAW_UPDATE),
  'team-turn turn/homeModerator delete event @root': known(F2, RAW_SYSTEM_TX),
  'team-turn turn/homeModerator edit event @folder': known(F2, RAW_UPDATE),
  'team-turn turn/writeGrant edit formula @root': known(F2, RAW_UPDATE),
  'team-turn turn/writeGrant edit note @folder': known(F2, RAW_UPDATE),
  'team-turn turn/writeGrant edit note @root': known(F2, RAW_UPDATE),
  'telegram turn/homeModerator delete app @folder': known(F2, RAW_SNAPSHOT),
  'telegram turn/homeModerator delete app @root': known(F2, RAW_SNAPSHOT),
  'telegram turn/homeModerator delete formula @folder': known(F2, RAW_SYSTEM_TX),
  'telegram turn/homeModerator delete task @root': known(F2, RAW_SYSTEM_TX),
  'telegram turn/homeModerator edit note @root': known(F2, RAW_UPDATE),
  'telegram turn/writeGrant edit note @folder': known(F2, RAW_UPDATE),
  'web-turn turn/homeModerator delete event @folder': known(F2, RAW_SYSTEM_TX),
  'web-turn turn/homeModerator edit task @root': known(F2, RAW_UPDATE),
  'web-turn turn/writeGrant edit event @folder': known(F2, RAW_UPDATE),
  'web-turn turn/writeGrant edit note @root': known(F2, RAW_UPDATE),
  'web-turn turn/writeGrant edit task @folder': known(F2, RAW_UPDATE),
  'peer login/owner edit note @admin': known(F6, 'a peer cannot change its content'),
  'peer login/writeGrant edit note @folder': known(F6, 'a peer cannot change its content'),
  'run turn/admin delete app @admin': known(F10, 'owner-side tool: not available here'),
  'mcp-oauth login/homeModerator delete app @folder': known(F5, APP_DELETED),
  'web login/homeModerator delete app @folder': known(F5, APP_DELETED),
};

/**
 * A run's failures against the list: `grid` the SQL grid's cells (a name
 * whose first word holds a '/'), else the surface cells' in check `mode`.
 * `unexpected`: a failure not listed (for this mode), or listed for another
 * reason (both fail the run); `fixed`: a listed cell that did not fail
 * (take it off the list, or off this mode).
 */
export function sortFailures(
  failures: ReadonlyMap<string, string>,
  grid: boolean,
  mode?: CheckMode,
): { unexpected: string[]; fixed: string[] } {
  const ours = (name: string) =>
    name.split(' ')[0]!.includes('/') === grid &&
    (grid || !mode || !KNOWN_FAILURES[name]?.modes || KNOWN_FAILURES[name]!.modes!.includes(mode));
  const unexpected: string[] = [];
  for (const [name, why] of failures) {
    const k = KNOWN_FAILURES[name];
    if (!k || !ours(name)) unexpected.push(`${name}: ${why}`);
    else if (!why.includes(k.reason)) {
      unexpected.push(`${name}: listed (${k.finding}) for "${k.reason}", fails with: ${why}`);
    }
  }
  const fixed = Object.keys(KNOWN_FAILURES).filter((n) => ours(n) && !failures.has(n));
  if (mode) return { unexpected, fixed: fixed.map((n) => `${n} (check ${mode})`) };
  return { unexpected, fixed };
}
