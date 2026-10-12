/**
 * The access oracle (workspaces arch plan v2, section 12 A8): what
 * docs/workspaces.md says a login may do with an item, written from the guide
 * alone. It imports NOTHING from the kind registry, the access matrix or the
 * SQL, so the grid that checks the database against it tests two independent
 * readings of the guide, not one reading twice.
 *
 * A1 starts it with two actions (read, create) at SQL level. Each later
 * phase adds actions, placements and surfaces; a cell the oracle does not
 * cover yet answers 'n/a' and the grid counts it.
 *
 * The fixture it speaks of (sql-grid.db.test.ts builds it): every item has
 * its home in workspace H, a grant with Write on to workspace W and a grant
 * with Write off to workspace R. In a folder, the folder F carries those
 * grants and the item takes them from F. Nothing is granted to Admin or Team.
 */

/** Who asks, relative to the fixture. */
export type OracleRole =
  /** The brain's first login: an Admin user, special only where the guide
   *  says (house style, persona, Telegram as owner, work with no login). */
  | 'owner'
  /** A user of the Admin workspace (every area): management, not reading. */
  | 'admin'
  /** A Moderator of the item's home workspace H. */
  | 'homeModerator'
  /** A user (no Moderator tick) of W, which holds a grant with Write on. */
  | 'writeGrant'
  /** A user (no Moderator tick) of R, which holds a grant with Write off. */
  | 'readGrant'
  /** In none of the item's workspaces. */
  | 'outsider';

export const ORACLE_ROLES: readonly OracleRole[] = [
  'owner',
  'admin',
  'homeModerator',
  'writeGrant',
  'readGrant',
  'outsider',
];

/** What is asked. A1: read and create; the rest join in later phases. */
export type OracleAction = 'read' | 'create';

/** Where the item is (read) or is made (create). */
export type OraclePlacement = 'root' | 'folder';

export type OracleContext = {
  /** The way in. A1: the SQL level only. Later: http, mcp, assistant, key,
   *  peer, each with its own narrowing. */
  surface: 'sql';
  placement: OraclePlacement;
};

/** Where a create lands, in the fixture's terms. */
export type OracleLanding = 'home' | 'private' | 'admin';

export type OracleAnswer =
  { allow: true; lands?: OracleLanding } | { allow: false; why: string } | { na: string };

/**
 * The kinds the guide names, by node type ("Kinds", docs/workspaces.md):
 * folders, files, notes, pages, tables, apps, formulas, drawings, tasks,
 * events and Recall maps are granted to any workspace; Telegram messages
 * are a class of their own; every other kind lives in Admin only. Written
 * out here from the guide's sentence, on purpose not taken from the
 * registry.
 */
const GUIDE_KIND_CLASS: Readonly<Record<string, 'workspace' | 'conversation'>> = {
  branch: 'workspace', // folders
  file: 'workspace',
  note: 'workspace',
  page: 'workspace',
  table: 'workspace',
  app: 'workspace',
  formula: 'workspace',
  draw: 'workspace', // drawings
  task: 'workspace',
  event: 'workspace',
  recall: 'workspace', // Recall maps
  telegram_message: 'conversation',
};

/** The guide's class of `kind`. */
export function guideKindClass(kind: string): 'workspace' | 'conversation' | 'admin_only' {
  return GUIDE_KIND_CLASS[kind] ?? 'admin_only';
}

/** The workspace kinds as the guide lists them. */
export function guideWorkspaceKinds(): string[] {
  return Object.keys(GUIDE_KIND_CLASS).filter((k) => GUIDE_KIND_CLASS[k] === 'workspace');
}

/** Whether `role` is a user of a workspace the fixture's item is granted
 *  to ("Read the item: to be a user of a workspace it is granted to"). An
 *  Admin user reads what is granted to the workspaces they are in, like
 *  anyone ("Being an Admin user is management, not reading"): the fixture
 *  grants nothing to Admin. */
function readsItem(role: OracleRole): boolean {
  return role === 'homeModerator' || role === 'writeGrant' || role === 'readGrant';
}

/** "Edit its content: Moderator of its home, or a grant with Write on." */
function editsItem(role: OracleRole): boolean {
  return role === 'homeModerator' || role === 'writeGrant';
}

/** Whether `role` is an Admin user (the owner is one). */
function isAdminUser(role: OracleRole): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * What the guide says `role` may do with `kind` here.
 *
 * read: the item (in F or at the kind's root) is read by the users of the
 * workspaces it is granted to.
 *
 * create, with no current workspace named (the home rule):
 *  - in folder F: "To place an item in folder F you may edit F"; it lands
 *    in F's home ("when you make it in a folder you may edit: the folder's
 *    home") and takes F's grants;
 *  - at the root: "your private workspace. An Admin user has no private
 *    fallback: the item lands in Admin."
 */
export function expectedAccess(
  context: OracleContext,
  role: OracleRole,
  kind: string,
  action: OracleAction,
): OracleAnswer {
  if (context.surface !== 'sql') return { na: `surface ${context.surface} not in the oracle yet` };
  if (guideKindClass(kind) !== 'workspace') {
    return { na: 'the grid covers the workspace kinds (A1)' };
  }
  if (action === 'read') {
    return readsItem(role)
      ? { allow: true }
      : { allow: false, why: 'not a user of a workspace the item is granted to' };
  }
  // create
  if (context.placement === 'folder') {
    return editsItem(role)
      ? { allow: true, lands: 'home' }
      : { allow: false, why: 'may not edit the folder' };
  }
  return { allow: true, lands: isAdminUser(role) ? 'admin' : 'private' };
}
