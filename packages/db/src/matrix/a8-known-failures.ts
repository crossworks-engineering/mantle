/**
 * The A8 cells that fail today (the database, or a way in, gives another
 * answer than the guide), each a finding for the owner to decide: the cell's
 * name (a8-grid.ts cellName; a surface cell's name starts with its surface)
 * and the finding it belongs to. A8 is test code only: a finding is never
 * fixed here. The grid and the surface cells fail on a failure not listed,
 * and on a listed one that passes (the list only shrinks). docs/actors.md,
 * "A8 matrix", names each finding.
 */

/** F1. /api/v1 refuses a key of a login outside Admin: 403 `member-login`
 *  (server/web/lib/api-v1.ts: "The v1 routes past whoami are admin routes").
 *  The guide: "A key acts as the login that made it, as that login is now.
 *  Its access ... and its areas only narrow that login", and an API only key
 *  "keeps working on /api/v1". Expected: the item read; actual: 403. The
 *  plan's D3 (v1 answers as its base route) is the pending decision. */
const F1 = 'F1 /api/v1 refuses member keys (guide: a key acts as its login)';

/** F2. A workspace assistant's turn (any workspace but Admin) cannot write an
 *  item its user may change by hand: the web turn, the team turn, Telegram,
 *  a run item and a recipe step. The turn scope of such an assistant has no
 *  write path (agent-viewer.ts: only the Admin turn enters with writes), so
 *  the write reaches the workspace role and fails. The guide: "It writes
 *  only for a user who could do it by hand: a Moderator of the home, or a
 *  grant with Write on". Expected: the edit or delete made; actual: refused,
 *  with a raw runtime or database text in the reply ("Failed query: update
 *  nodes ...", "withSystemTx: only outside a viewer scope ..."), a generic
 *  error where the mapper's words belong. */
const F2 = 'F2 a workspace assistant turn cannot write (raw error text)';

/** F3. app_delete is an owner-side tool: on the team surface the home
 *  Moderator's delete of an app is refused ("owner-side tool: not available
 *  here"). The guide: "Delete it: Moderator of its home"; "An app is an item:
 *  it has a home and grants like a page". */
const F3 = 'F3 app_delete is owner-only on the team surface';

export const KNOWN_FAILURES: Readonly<Record<string, string>> = {
  'api-v1 login/homeModerator read file @folder': F1,
  'api-v1 login/homeModerator read note @folder': F1,
  'api-v1 login/homeModerator read table @root': F1,
  'api-v1 login/homeModerator read task @folder': F1,
  'api-v1 login/readGrant read file @root': F1,
  'api-v1 login/readGrant read page @folder': F1,
  'api-v1 login/readGrant read table @folder': F1,
  'api-v1 login/readGrant read task @folder': F1,
  'api-v1 login/writeGrant read file @folder': F1,
  'api-v1 login/writeGrant read note @folder': F1,
  'api-v1 login/writeGrant read page @root': F1,
  'api-v1 login/writeGrant read table @snapshot': F1,
  'api-v1 login/writeGrant read task @folder': F1,
  'web-turn turn/homeModerator delete task @root': F2,
  'web-turn turn/homeModerator edit formula @folder': F2,
  'team-turn turn/homeModerator edit note @root': F2,
  'team-turn turn/writeGrant edit event @folder': F2,
  'team-turn turn/writeGrant edit task @folder': F2,
  'telegram turn/homeModerator delete task @root': F2,
  'telegram turn/homeModerator edit formula @folder': F2,
  'run turn/homeModerator delete task @root': F2,
  'run turn/homeModerator edit formula @folder': F2,
  'recipe turn/homeModerator delete task @root': F2,
  'recipe turn/homeModerator edit formula @folder': F2,
  'team-turn turn/homeModerator delete app @folder': F3,
};
