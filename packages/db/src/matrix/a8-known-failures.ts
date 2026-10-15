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

/** F6. A peer acting as its login, Write on, may not change an item others
 *  read (packages/tools/src/key-shared-content.ts: "this item is shared, so
 *  a peer cannot change its content"; access matrix T3). The guide's
 *  "Linked brains": a peer with Acts as "gets the MCP surface as that login,
 *  as the login is now", narrowed by its Write switch and its risky tools
 *  only. A rule the product has and the guide does not name (every fixture
 *  item is read by W and R, and has an open link). */
const F6 = 'F6 a peer may not edit a shared item (a rule the guide does not name)';

/** F9. A contact share's write is named system work on the system pool
 *  (docs/actors.md: "its app's data, when the share allows it"), so the
 *  database holds a statement it sends to nothing but a snapshot copy's
 *  read-only rule: an edit, a draft, a delete, a move, a grant change, a
 *  link and a create of any item are made. Only the /s broker holds it, by
 *  sending none but its app's data (the contact-share surface cells pass,
 *  and its deny cells: an Informational app, a share that is no app).
 *  The guide: a contact share writes only its app's data. A defence in
 *  depth gap, not reachable by a contact today (the round 2 re-audit), with
 *  one caveat: the debounced export sync
 *  (packages/content/src/app-table-exports.ts scheduleAppTableExportSync, a
 *  setTimeout) inherits the request's contact:rw actor, so its writes run
 *  as the contact. The fix point: a statement trigger next to
 *  mantle_edit_check_ro (migration 0280, section 5) refusing a statement on
 *  an item table but app_databases WHEN mantle.actor = 'contact:rw', and the
 *  dirty stamp and the export sync bound to a named system actor. */
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
  // The surface cells (all three check modes unless named).
  'peer login/owner edit note @admin': known(F6, 'a peer cannot change its content'),
  'peer login/writeGrant edit note @folder': known(F6, 'a peer cannot change its content'),
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
