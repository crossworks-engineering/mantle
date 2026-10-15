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

export type KnownFailure = {
  /** The finding (F1, F2, ...). */
  finding: string;
  /** A piece of the cell's failure reason, as the run prints it. */
  reason: string;
};

const MEMBER_LOGIN = '"reason":"member-login"';
const RAW_UPDATE = 'Failed query: update "nodes"';
const RAW_SYSTEM_TX = 'withSystemTx: only outside a viewer scope';
const known = (finding: string, reason: string): KnownFailure => ({ finding, reason });

export const KNOWN_FAILURES: Readonly<Record<string, KnownFailure>> = {
  'api-v1 login/homeModerator read file @folder': known(F1, MEMBER_LOGIN),
  'api-v1 login/homeModerator read note @folder': known(F1, MEMBER_LOGIN),
  'api-v1 login/homeModerator read table @root': known(F1, MEMBER_LOGIN),
  'api-v1 login/homeModerator read task @folder': known(F1, MEMBER_LOGIN),
  'api-v1 login/readGrant read file @root': known(F1, MEMBER_LOGIN),
  'api-v1 login/readGrant read page @folder': known(F1, MEMBER_LOGIN),
  'api-v1 login/readGrant read table @folder': known(F1, MEMBER_LOGIN),
  'api-v1 login/readGrant read task @folder': known(F1, MEMBER_LOGIN),
  'api-v1 login/writeGrant read file @folder': known(F1, MEMBER_LOGIN),
  'api-v1 login/writeGrant read note @folder': known(F1, MEMBER_LOGIN),
  'api-v1 login/writeGrant read page @root': known(F1, MEMBER_LOGIN),
  'api-v1 login/writeGrant read table @snapshot': known(F1, MEMBER_LOGIN),
  'api-v1 login/writeGrant read task @folder': known(F1, MEMBER_LOGIN),
  'web-turn turn/homeModerator delete task @root': known(F2, RAW_SYSTEM_TX),
  'web-turn turn/homeModerator edit formula @folder': known(F2, RAW_UPDATE),
  'team-turn turn/homeModerator edit note @root': known(F2, RAW_UPDATE),
  'team-turn turn/writeGrant edit event @folder': known(F2, RAW_UPDATE),
  'team-turn turn/writeGrant edit task @folder': known(F2, RAW_UPDATE),
  'telegram turn/homeModerator delete task @root': known(F2, RAW_SYSTEM_TX),
  'telegram turn/homeModerator edit formula @folder': known(F2, RAW_UPDATE),
  'run turn/homeModerator delete task @root': known(F2, RAW_SYSTEM_TX),
  'run turn/homeModerator edit formula @folder': known(F2, RAW_UPDATE),
  'recipe turn/homeModerator delete task @root': known(F2, RAW_SYSTEM_TX),
  'recipe turn/homeModerator edit formula @folder': known(F2, RAW_UPDATE),
};

/**
 * A run's failures against the list: `grid` the SQL grid's cells (a name
 * whose first word holds a '/'), else the surface cells'. `unexpected`: a
 * failure not listed, or listed for another reason (both fail the run);
 * `fixed`: a listed cell that did not fail (take it off the list).
 */
export function sortFailures(
  failures: ReadonlyMap<string, string>,
  grid: boolean,
): { unexpected: string[]; fixed: string[] } {
  const ours = (name: string) => name.split(' ')[0]!.includes('/') === grid;
  const unexpected: string[] = [];
  for (const [name, why] of failures) {
    const k = KNOWN_FAILURES[name];
    if (!k || !ours(name)) unexpected.push(`${name}: ${why}`);
    else if (!why.includes(k.reason)) {
      unexpected.push(`${name}: listed (${k.finding}) for "${k.reason}", fails with: ${why}`);
    }
  }
  const fixed = Object.keys(KNOWN_FAILURES).filter((n) => ours(n) && !failures.has(n));
  return { unexpected, fixed };
}
