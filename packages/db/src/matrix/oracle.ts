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

// ── Folder counts (task b6e4a8aa) ───────────────────────────────────────────

/**
 * The folder-count fixture: a folder homed in workspace H and granted to
 * workspace S. Inside it, three notes (they take the folder's grants);
 * "Remove from this workspace" marks S "Removed here" on two of them
 * ('oneOfThree') or on all three and on a subfolder ('noneShared').
 */
export type FolderCountCase = 'noneShared' | 'oneOfThree';

/** Who opens the folder: a user of S only; an Admin user who is also a
 *  user of S; an Admin user who is a user of H and S. */
export type FolderCountCaller = 'member' | 'adminUser' | 'adminUserInHome';

/** The scope: all the caller's workspaces, or S or H picked in the
 *  switcher. An MCP call has no switcher: all its workspaces. */
export type FolderCountScope = 'all' | 'S' | 'H';

/** The folder shows with these counts, or the pick is refused. */
export type FolderCountAnswer =
  { shows: true; items: number; folders: number } | { refused: string };

/** The workspaces each caller is a user of, by the fixture's names. */
const FOLDER_COUNT_CALLERS: Readonly<Record<FolderCountCaller, readonly string[]>> = {
  member: ['S'],
  adminUser: ['Admin', 'S'],
  adminUserInHome: ['Admin', 'H', 'S'],
};

/** What each case holds: per child, the workspaces it is granted to (and
 *  not "Removed here"). The folder itself is granted to H and S. */
const FOLDER_COUNT_CONTENTS: Readonly<
  Record<FolderCountCase, { items: readonly string[][]; folders: readonly string[][] }>
> = {
  oneOfThree: { items: [['H', 'S'], ['H'], ['H']], folders: [] },
  noneShared: { items: [['H'], ['H'], ['H']], folders: [['H']] },
};

/**
 * What the guide says the folder shows ("A folder's counts are yours",
 * docs/workspaces.md, Folders):
 *  - an item is read by the users of the workspaces it is granted to;
 *    "Being an Admin user is management, not reading";
 *  - the item count is what the caller reads, and with a picked workspace
 *    what that workspace reads too;
 *  - the folder count is the folders the caller reads; the pick does not
 *    narrow it;
 *  - a folder the caller reads shows, even with nothing in it to read;
 *  - "You pick only a workspace you are in, Admin users too" (the
 *    workspaces section of the guide).
 */
export function expectedFolderCount(
  c: FolderCountCase,
  caller: FolderCountCaller,
  scope: FolderCountScope,
): FolderCountAnswer {
  const mine = FOLDER_COUNT_CALLERS[caller];
  if (scope !== 'all' && !mine.includes(scope)) {
    return { refused: 'not a workspace of the caller' };
  }
  const reads = (ws: readonly string[]) => ws.some((w) => mine.includes(w));
  const box = FOLDER_COUNT_CONTENTS[c];
  return {
    shows: true,
    items: box.items.filter((ws) => reads(ws) && (scope === 'all' || ws.includes(scope))).length,
    folders: box.folders.filter(reads).length,
  };
}

// ── Writes (workspaces arch A3a) ────────────────────────────────────────────

/**
 * The write grid's logins: the six above, and two Admin users who are also
 * users of a workspace the item is granted to (W, with Write on; R, with
 * Write off), so the rules that ask "an Admin user" meet one who reads the
 * item ("Being an Admin user is management, not reading").
 */
export type OracleWriteRole = OracleRole | 'adminWriteGrant' | 'adminReadGrant';

export const ORACLE_WRITE_ROLES: readonly OracleWriteRole[] = [
  ...ORACLE_ROLES,
  'adminWriteGrant',
  'adminReadGrant',
];

/** Who a statement runs as (docs/actors.md, the actor kinds). */
export type OracleActor =
  'login' | 'login-ro' | 'assistant' | 'link' | 'peer' | 'contact-ro' | 'system';

export const ORACLE_ACTORS: readonly OracleActor[] = [
  'login',
  'login-ro',
  'assistant',
  'link',
  'peer',
  'contact-ro',
  'system',
];

/** What a write does to the fixture's item. */
export type OracleWriteAction =
  /** Make a new item of the kind where the fixture's item is. */
  | 'create'
  /** Change its content (its title). */
  | 'edit'
  /** Move it on a board (its rank alone). */
  | 'rank'
  /** Set a value only the brain derives (a summary). */
  | 'derived'
  /** Delete it. */
  | 'delete'
  /** Delete its content row (a page's, a drawing's, a table's). */
  | 'deleteContent'
  /** Open a public link to it. */
  | 'openLink'
  /** Close its public link. */
  | 'closeLink'
  /** Change an app's code (its draft). */
  | 'appCode'
  /** Set an app's MCP access switch. */
  | 'appSwitch'
  /** Write an app's data. */
  | 'appData'
  /** Write the data of an app whose Informational switch is on. */
  | 'appDataInformational'
  /** Change a Recall map's card. */
  | 'recallCard'
  /** Change an item's history row (an app version, a table snapshot). */
  | 'history';

export const ORACLE_WRITE_ACTIONS: readonly OracleWriteAction[] = [
  'create',
  'edit',
  'rank',
  'derived',
  'delete',
  'deleteContent',
  'openLink',
  'closeLink',
  'appCode',
  'appSwitch',
  'appData',
  'appDataInformational',
  'recallCard',
  'history',
];

/** The kinds an action applies to (the item has the row it changes). */
function actionApplies(kind: string, action: OracleWriteAction): boolean {
  switch (action) {
    case 'deleteContent':
      return kind === 'page' || kind === 'draw' || kind === 'table';
    case 'appCode':
    case 'appSwitch':
    case 'appData':
    case 'appDataInformational':
      return kind === 'app';
    case 'recallCard':
      return kind === 'recall';
    case 'history':
      return kind === 'app' || kind === 'table';
    default:
      return true;
  }
}

function readsForWrite(role: OracleWriteRole): boolean {
  return role === 'adminWriteGrant' || role === 'adminReadGrant' || readsItem(role as OracleRole);
}

function editsForWrite(role: OracleWriteRole): boolean {
  return role === 'adminWriteGrant' || editsItem(role as OracleRole);
}

function adminForWrite(role: OracleWriteRole): boolean {
  return role === 'adminWriteGrant' || role === 'adminReadGrant' || isAdminUser(role as OracleRole);
}

/**
 * What the guide (docs/workspaces.md, "Items and grants" and "Apps";
 * docs/actors.md, the actor kinds; the owner's decisions D4 to D6) says a
 * write may do, at SQL level, in the fixture of expectedAccess:
 *  - a read key, an assistant with no user, a public link, a peer and a
 *    contact share without Can write write nothing; system work writes
 *    what its reason needs;
 *  - a login changes only an item it reads ("An item the caller may not
 *    read answers not found");
 *  - edit its content, its board rank: Moderator of its home, or a grant
 *    with Write on (the rank: or of its folder; in the fixture the folder's
 *    grants are the item's);
 *  - a value only the brain derives (a summary): nobody but the brain;
 *  - delete it (and its content row): Moderator of its home;
 *  - open, change or close its link: be able to edit it, an app: Moderator
 *    of its home; close any public link: an Admin user with the users area;
 *  - an app's code: a Moderator of its home (D4); its switches: Admin
 *    users only (D5), on an app they may edit (the switch is a change of
 *    the app); its data: edit, and while Informational is on nobody
 *    outside Admin (D6);
 *  - a Recall card, an item's history row: edit of the item.
 */
export function expectedWrite(
  context: { surface: 'sql'; placement: OraclePlacement; actor: OracleActor },
  role: OracleWriteRole,
  kind: string,
  action: OracleWriteAction,
): OracleAnswer {
  if (guideKindClass(kind) !== 'workspace') return { na: 'the grid covers the workspace kinds' };
  if (!actionApplies(kind, action)) return { na: `${action} is not a change of a ${kind}` };
  switch (context.actor) {
    case 'system':
      return { allow: true };
    case 'login-ro':
    case 'assistant':
    case 'link':
    case 'peer':
    case 'contact-ro':
      return { allow: false, why: 'this caller only reads' };
    default:
      break;
  }
  // A login's create is the read and create grid's (expectedAccess, with
  // where it lands): here only the other actor kinds make one.
  if (action === 'create') return { na: "a login's create: expectedAccess (sql-grid)" };
  if (!readsForWrite(role)) return { allow: false, why: 'not found: it does not read the item' };
  const homeMod = role === 'homeModerator';
  const deny = (why: string): OracleAnswer => ({ allow: false, why });
  switch (action) {
    case 'edit':
    case 'rank':
    case 'recallCard':
    case 'history':
    case 'appData':
      return editsForWrite(role) ? { allow: true } : deny('may not edit it');
    case 'appDataInformational':
      return editsForWrite(role) && adminForWrite(role)
        ? { allow: true }
        : deny('Informational: nobody outside Admin writes its data');
    case 'derived':
      return deny('only the brain sets that value');
    case 'delete':
    case 'deleteContent':
    case 'appCode':
      return homeMod ? { allow: true } : deny('not a Moderator of its home');
    case 'openLink':
      return (kind === 'app' ? homeMod : editsForWrite(role))
        ? { allow: true }
        : deny('may not open its link');
    case 'closeLink':
      return (kind === 'app' ? homeMod : editsForWrite(role)) || adminForWrite(role)
        ? { allow: true }
        : deny('may not close its link');
    case 'appSwitch':
      return adminForWrite(role) && editsForWrite(role)
        ? { allow: true }
        : deny('an Admin user sets it');
  }
}
