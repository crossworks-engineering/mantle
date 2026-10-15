/**
 * The A8 oracle (workspaces arch plan v2, section 12 A8): what the guide says
 * a caller may do with an item, written from the guide's text alone. It
 * imports NOTHING (no kind registry, no access matrix, no SQL, no gate), so
 * the grid that checks the database against it, and the surface cells that
 * check each way in against it, test two independent readings of the guide.
 *
 * The guide is docs/workspaces.md. Each rule below names its section there
 * ("Items and grants", "The home rule", "Folders", "Assistants and chats",
 * "MCP, API keys and linked brains", "Apps"), docs/actors.md ("The actor
 * kinds") for who a statement runs as, and docs/update-prod.md ("Snapshot
 * copies (plan S3)") for the snapshot copy, which docs/workspaces.md does not
 * describe (a gap the A8 report names).
 *
 * THE FIXTURE it speaks of (a8-fixture.ts builds it; the grid pins it):
 *
 *   Workspaces  Admin (owner, admin: Moderators)
 *               H, the item's home (homeModerator: Moderator)
 *               W, a grant with Write on (writeGrant: a user, no tick)
 *               R, a grant with Write off (readGrant and homeModerator:
 *                 Moderators)
 *               T, a target with no grant (homeModerator and writeGrant:
 *                 Moderators)
 *               O (outsider: Moderator), nothing granted to it
 *               each login outside Admin: its private workspace (Moderator)
 *   Placements  folder: the item sits in folder F (home H; W with Write on,
 *                 R with Write off), and takes F's grants;
 *               root: the item sits at its kind's root with the same grants
 *                 set by hand;
 *               snapshot: the author's read-only snapshot copy, at its
 *                 kind's root, homed in writeGrant's private workspace
 *                 (Write off), no other grant. Only the kinds an accepted
 *                 item can be have one.
 *   Actions     the 13 of the plan (section 12 A8; v1's list): read, list,
 *               search, edit content, edit draft, delete, move (H to T), add
 *               a grant (to T), remove a grant (R's), the Write switch (on
 *               for R), a public link (open one), create (in the item's
 *               folder, or at its kind's root), app data write.
 *   Actors      docs/actors.md's kinds: login (rw; the owner's is
 *               login(owner)), login-ro (a read key, a peer acting as the
 *               login with Write off), turn (an assistant turn for the login,
 *               in the assistant's workspace: the role's own, see
 *               TURN_WORKSPACE), assistant (an assistant of W with no user:
 *               a heartbeat), link (an open public link), contact-ro and
 *               contact-rw (a contact share without and with Can write),
 *               peer (a peer without Acts as) and system.
 */

/** Who asks, relative to the fixture. */
export type GuideRole =
  /** The brain's first login: an Admin user, special only where the guide
   *  says ("The owner"). */
  | 'owner'
  /** A user of the Admin workspace. */
  | 'admin'
  /** A Moderator of the item's home H (and of R and T). */
  | 'homeModerator'
  /** A user of W (Write on); a Moderator of T; the snapshot copy's author. */
  | 'writeGrant'
  /** A Moderator of R (Write off). */
  | 'readGrant'
  /** In none of the item's workspaces (a Moderator of O). */
  | 'outsider';

export const GUIDE_ROLES: readonly GuideRole[] = [
  'owner',
  'admin',
  'homeModerator',
  'writeGrant',
  'readGrant',
  'outsider',
];

export type GuidePlacement = 'folder' | 'root' | 'snapshot';
export const GUIDE_PLACEMENTS: readonly GuidePlacement[] = ['folder', 'root', 'snapshot'];

export type GuideAction =
  | 'read'
  | 'list'
  | 'search'
  | 'edit'
  | 'editDraft'
  | 'delete'
  | 'move'
  | 'grantAdd'
  | 'grantRemove'
  | 'writeSwitch'
  | 'link'
  | 'create'
  | 'appData';

export const GUIDE_ACTIONS: readonly GuideAction[] = [
  'read',
  'list',
  'search',
  'edit',
  'editDraft',
  'delete',
  'move',
  'grantAdd',
  'grantRemove',
  'writeSwitch',
  'link',
  'create',
  'appData',
];

export type GuideActor =
  | 'login'
  | 'login-ro'
  | 'turn'
  | 'assistant'
  | 'link'
  | 'contact-ro'
  | 'contact-rw'
  | 'peer'
  | 'system';

/** The actor kinds that ask for a login (the grid runs them for each role). */
export const GUIDE_LOGIN_ACTORS: readonly GuideActor[] = ['login', 'login-ro', 'turn'];
/** The actor kinds that answer no login (the grid runs them once). */
export const GUIDE_OTHER_ACTORS: readonly GuideActor[] = [
  'assistant',
  'link',
  'contact-ro',
  'contact-rw',
  'peer',
  'system',
];

/** The ways in (plan 4.3). 'sql' is the grid; the rest are surface cells. */
export type GuideSurface =
  | 'sql'
  | 'web'
  | 'api-v1'
  | 'mcp-oauth'
  | 'mcp-key'
  | 'mcp-stdio'
  | 'peer'
  | 'web-turn'
  | 'team-turn'
  | 'telegram'
  | 'heartbeat'
  | 'run'
  | 'recipe'
  | 'pending'
  | 'app-broker'
  | 'share-link';

export type GuideContext = {
  surface: GuideSurface;
  placement: GuidePlacement;
  actor: GuideActor;
};

/** Where a create lands, in the fixture's terms. */
export type GuideLanding = 'H' | 'R' | 'O' | 'private' | 'admin';

export type GuideAnswer =
  { allow: true; lands?: GuideLanding } | { allow: false; why: string } | { na: string };

/** The fixture's workspaces by name. */
export type GuideWorkspace = 'admin' | 'H' | 'W' | 'R' | 'T' | 'O' | 'private';

/**
 * Each role's workspaces and Moderator ticks in the fixture. 'private' is
 * the login's own private workspace (docs/workspaces.md, "Workspaces and
 * users": "A private workspace per user ... Nobody else is in it"; the brain
 * makes it the first time the user needs it). An Admin user has none.
 */
const SEATS: Readonly<Record<GuideRole, { users: GuideWorkspace[]; mods: GuideWorkspace[] }>> = {
  owner: { users: ['admin'], mods: ['admin'] },
  admin: { users: ['admin'], mods: ['admin'] },
  homeModerator: { users: ['H', 'R', 'T', 'private'], mods: ['H', 'R', 'T', 'private'] },
  writeGrant: { users: ['W', 'T', 'private'], mods: ['T', 'private'] },
  readGrant: { users: ['R', 'private'], mods: ['R', 'private'] },
  outsider: { users: ['O', 'private'], mods: ['O', 'private'] },
};

/**
 * The workspace of the assistant a role's turn talks to: its own assistant
 * ("One assistant per workspace", "Assistants and chats"). The Admin users
 * talk to the Admin assistant.
 */
export const TURN_WORKSPACE: Readonly<Record<GuideRole, GuideWorkspace>> = {
  owner: 'admin',
  admin: 'admin',
  homeModerator: 'H',
  writeGrant: 'W',
  readGrant: 'R',
  outsider: 'O',
};

/** The assistant with no user (a heartbeat) is W's. */
export const ASSISTANT_WORKSPACE: GuideWorkspace = 'W';

/**
 * The workspace kinds as the guide lists them ("Items and grants", Kinds:
 * "Folders, files, notes, pages, tables, apps, formulas, drawings, tasks,
 * events and Recall maps can be granted to any workspace"), by node type.
 * Written out here on purpose, not taken from the registry.
 */
export const GUIDE_WORKSPACE_KINDS: readonly string[] = Object.keys({
  branch: 'folders',
  file: 'files',
  note: 'notes',
  page: 'pages',
  table: 'tables',
  app: 'apps',
  formula: 'formulas',
  draw: 'drawings',
  task: 'tasks',
  event: 'events',
  recall: 'Recall maps',
});

/**
 * The kinds with a snapshot copy: an accepted item's kinds (update-prod.md,
 * "Snapshot copies": "the author's read-only copy ... from the accepted
 * version"; a file changed since gets none). Notes, pages, drawings, tables
 * and files.
 */
export const GUIDE_SNAPSHOT_KINDS: readonly string[] = Object.keys({
  note: 'notes',
  page: 'pages',
  draw: 'drawings',
  table: 'tables',
  file: 'files',
});

/** The kinds with a draft beside their content (pages, drawings, tables:
 *  the draft and commit of rich-writing; an app's draft is its code). */
const DRAFT_KINDS: readonly string[] = Object.keys({
  page: 'draft_doc',
  draw: 'draft_scene',
  table: 'draft_data',
  app: 'draft_source',
});

/** The grants each placement's item holds: workspace -> Write. */
function grantsOf(placement: GuidePlacement): {
  home: GuideWorkspace;
  write: GuideWorkspace[];
  read: GuideWorkspace[];
} {
  // snapshot: "Its grants: one home row, Write off, in a private ...
  // workspace" (update-prod.md); writeGrant is its author.
  if (placement === 'snapshot') return { home: 'private', write: [], read: ['private'] };
  return { home: 'H', write: ['W'], read: ['H', 'W', 'R'] };
}

type Seats = { users: GuideWorkspace[]; mods: GuideWorkspace[] };

/** The seats a caller acts with: its own, or, in a turn, the assistant's
 *  workspace alone ("It reads only its workspace's items, also when the
 *  user who asks is in other workspaces"). A private workspace is the
 *  role's own: the snapshot copy's is writeGrant's alone. */
function seatsFor(
  role: GuideRole,
  placement: GuidePlacement,
  narrowTo: GuideWorkspace | null,
): Seats {
  const own = SEATS[role];
  // Only writeGrant's private workspace is the snapshot copy's home.
  const mine = (w: GuideWorkspace) =>
    w !== 'private' || role === 'writeGrant' || placement !== 'snapshot';
  const users = own.users.filter(mine);
  const mods = own.mods.filter(mine);
  if (!narrowTo) return { users, mods };
  return {
    users: users.filter((w) => w === narrowTo),
    mods: mods.filter((w) => w === narrowTo),
  };
}

const deny = (why: string): GuideAnswer => ({ allow: false, why });

/**
 * What the guide says a caller in `context` may do as `role` with the
 * fixture's item of `kind`, for `action`. `role` is ignored for an actor that
 * answers no login (pass null).
 */
export function expectedAccess(
  context: GuideContext,
  role: GuideRole | null,
  kind: string,
  action: GuideAction,
): GuideAnswer {
  const { placement, actor, surface } = context;
  if (!GUIDE_WORKSPACE_KINDS.includes(kind)) {
    return { na: 'the matrix covers the workspace kinds ("Items and grants", Kinds)' };
  }
  if (placement === 'snapshot' && !GUIDE_SNAPSHOT_KINDS.includes(kind)) {
    return { na: `no snapshot copy of a ${kind} is made (only an accepted item's kinds)` };
  }
  if (action === 'editDraft' && !DRAFT_KINDS.includes(kind)) {
    return { na: `a ${kind} has no draft` };
  }
  if (action === 'appData' && kind !== 'app') return { na: 'only an app has data' };
  if (placement === 'snapshot') {
    // "Its grants: one home row": there is no grant of R to take away or to
    // switch, and a copy is no place to make an item in.
    if (action === 'grantRemove' || action === 'writeSwitch') {
      return { na: 'a snapshot copy holds no grant but its home' };
    }
    if (action === 'create') return { na: 'a snapshot copy is not a place to create in' };
  }

  const reads = READ_ACTIONS.includes(action);

  switch (actor) {
    case 'system':
      return systemAnswer(placement, action);
    case 'link':
    case 'contact-ro':
    case 'contact-rw':
    case 'peer': {
      if (reads) {
        // At SQL level these read through their share's own gate (the
        // served list, the contact share, the peer's shares), not the
        // workspace role: the surface cells check them.
        if (surface === 'sql') return { na: `${actor} reads through its share, not a scope` };
        if (action !== 'read') return { na: `${actor} has no ${action}` };
        // A public link serves its item ("Public links and contact shares
        // stay per item"); a snapshot copy carries none (update-prod.md).
        if (placement === 'snapshot') return { na: 'a snapshot copy carries no link or share' };
        return { allow: true };
      }
      // docs/actors.md: a link, a peer(share) and a contact without Can
      // write write nothing; a contact with Can write writes its app's
      // data only (as named system work after the share's own check).
      if (actor === 'contact-rw') {
        if (action !== 'appData') {
          return { na: 'a contact share writes only its app’s data (the /s broker)' };
        }
        return { allow: true };
      }
      return deny('this caller only reads');
    }
    case 'assistant': {
      // "With no user (a heartbeat, a scheduled run) an assistant only
      // reads", and "It reads only its workspace's items".
      if (reads) {
        return grantsOf(placement).read.includes(ASSISTANT_WORKSPACE)
          ? { allow: true }
          : deny('not granted to the assistant’s workspace');
      }
      return deny('an assistant with no user only reads');
    }
    default:
      break;
  }

  if (!role) throw new Error(`expectedAccess: actor ${actor} needs a role`);
  const narrowTo = actor === 'turn' ? TURN_WORKSPACE[role] : null;
  const seats = seatsFor(role, placement, narrowTo);
  const g = grantsOf(placement);
  const readsItem = g.read.some((w) => seats.users.includes(w));
  if (reads) {
    // "Read the item: to be a user of a workspace it is granted to"; "Being
    // an Admin user is management, not reading" ("Admin areas"); "Memory
    // follows the item": passages are read only where the item is read.
    return readsItem ? { allow: true } : deny('not a user of a workspace it is granted to');
  }

  if (actor === 'login-ro') {
    // A read-only key, a peer with Write off: "Its access (read only, or
    // read and write) ... only narrow that login" ("MCP, API keys").
    return deny('a read-only caller writes nothing');
  }

  if (action === 'create') return createAnswer(role, placement, seats, narrowTo);

  // "An item the caller may not read answers not found".
  if (!readsItem) return deny('not found: it does not read the item');

  const homeMod = seats.mods.includes(g.home);
  const edits = homeMod || g.write.some((w) => seats.users.includes(w));
  const modOf = (w: GuideWorkspace) => seats.mods.includes(w);

  // The guide does not say whether a turn's write may use a Moderator seat
  // outside the assistant's workspace ("It writes only for a user who could
  // do it by hand" against "It reads only its workspace's items"). Where the
  // two readings part, the cell is not applicable and the report names it.
  if (narrowTo) {
    const byHand = expectedAccess({ ...context, actor: 'login' }, role, kind, action);
    const narrowed = narrowedAnswer(placement, kind, action, { homeMod, edits, modOf });
    if ('allow' in byHand && 'allow' in narrowed && byHand.allow !== narrowed.allow) {
      return { na: 'guide silent: a turn’s write and a Moderator seat outside its workspace' };
    }
    return narrowed;
  }
  return narrowedAnswer(placement, kind, action, { homeMod, edits, modOf });
}

const READ_ACTIONS: readonly GuideAction[] = ['read', 'list', 'search'];

/** A write's answer from the caller's standing on an item it reads. */
function narrowedAnswer(
  placement: GuidePlacement,
  kind: string,
  action: GuideAction,
  s: { homeMod: boolean; edits: boolean; modOf: (w: GuideWorkspace) => boolean },
): GuideAnswer {
  const snapshot = placement === 'snapshot';
  // update-prod.md: "A copy is read only for everyone, its author included:
  // the database refuses any change to it, a move out of its private
  // workspace and any new grant; its author may delete it." A link on it
  // would share it (0267 fix round 2, "nobody ... shares it").
  const readOnlyCopy = deny('a snapshot copy is read only for everyone');
  switch (action) {
    case 'edit':
      // "Edit its content: Moderator of its home, or a grant with Write on".
      if (snapshot) return readOnlyCopy;
      return s.edits ? { allow: true } : deny('may not edit it');
    case 'editDraft':
      if (snapshot) return readOnlyCopy;
      // "Apps": "Code. A Moderator of the app's home builds and edits it."
      if (kind === 'app')
        return s.homeMod ? { allow: true } : deny('app code: Moderator of its home');
      return s.edits ? { allow: true } : deny('may not edit it');
    case 'delete':
      // "Delete it: Moderator of its home" (the copy's author is one).
      return s.homeMod ? { allow: true } : deny('not a Moderator of its home');
    case 'move':
      // "Move it to another home (H to T): Moderator of H and Moderator of T".
      if (snapshot) return readOnlyCopy;
      return s.homeMod && s.modOf('T') ? { allow: true } : deny('move: Moderator of H and of T');
    case 'grantAdd':
      // "Add a grant to workspace T: Moderator of its home and Moderator of T".
      if (snapshot) return readOnlyCopy;
      return s.homeMod && s.modOf('T')
        ? { allow: true }
        : deny('add: Moderator of its home and of T');
    case 'grantRemove':
      // "Remove a grant from T: Moderator of its home, or Moderator of T"
      // (here R's grant; in a folder, "Remove from this workspace").
      return s.homeMod || s.modOf('R')
        ? { allow: true }
        : deny('remove: Moderator of its home or of R');
    case 'writeSwitch':
      // "Switch Write on for T: Moderator of its home and Moderator of T".
      return s.homeMod && s.modOf('R')
        ? { allow: true }
        : deny('Write on: Moderator of its home and of R');
    case 'link':
      // "Open, change or close its link: to be able to edit it (an app:
      // Moderator of its home)".
      if (snapshot) return readOnlyCopy;
      if (kind === 'app')
        return s.homeMod ? { allow: true } : deny('an app’s link: Moderator of its home');
      return s.edits ? { allow: true } : deny('may not open its link');
    case 'appData':
      // "Apps": "A user writes the app's data when they may edit the app"
      // (Informational is off in the fixture).
      return s.edits ? { allow: true } : deny('may not write the app’s data');
    default:
      throw new Error(`narrowedAnswer: ${action}`);
  }
}

/**
 * "The home rule" ("Where a new item lands") and "Folders" ("To place an
 * item in folder F you may edit F"):
 *  1. the current workspace, when you moderate it (in a chat: the
 *     assistant's workspace; the grid's login writes name none);
 *  2. else, in a folder you may edit, the folder's home;
 *  3. else your private workspace; an Admin user lands in Admin.
 */
function createAnswer(
  role: GuideRole,
  placement: GuidePlacement,
  seats: Seats,
  narrowTo: GuideWorkspace | null,
): GuideAnswer {
  const admin = SEATS[role].users.includes('admin');
  if (placement === 'folder') {
    const g = grantsOf('folder');
    const editsF = seats.mods.includes(g.home) || g.write.some((w) => seats.users.includes(w));
    if (!editsF) return deny('may not edit the folder');
    if (narrowTo && seats.mods.includes(narrowTo)) return { allow: true, lands: landing(narrowTo) };
    return { allow: true, lands: 'H' };
  }
  if (narrowTo && seats.mods.includes(narrowTo)) return { allow: true, lands: landing(narrowTo) };
  return { allow: true, lands: admin ? 'admin' : 'private' };
}

function landing(w: GuideWorkspace): GuideLanding {
  if (w === 'H' || w === 'R' || w === 'O' || w === 'private' || w === 'admin') return w;
  throw new Error(`no landing for ${w}`);
}

/** System work writes what its reason needs (docs/actors.md); a snapshot
 *  copy refuses every change but a delete, for everyone (update-prod.md). */
function systemAnswer(placement: GuidePlacement, action: GuideAction): GuideAnswer {
  if (
    placement === 'snapshot' &&
    ['edit', 'editDraft', 'move', 'grantAdd', 'link'].includes(action)
  ) {
    return deny('a snapshot copy is read only for everyone');
  }
  return { allow: true };
}
