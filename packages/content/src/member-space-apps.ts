/**
 * Members build mini apps (team apps Phase 3, plan page b6dd688e, sections
 * A.2 to A.5; decided by Jason 2026-10-08: "apps work like Pages").
 *
 * A member's app is a personal-space item: its node is owned by the
 * member's personal space, at admin audience (as every space item), with a
 * `space_items` row naming its author.
 *
 *  - Draft (private): only the author runs it. Admins never see it (rule S3:
 *    no owner surface lists a space's nodes).
 *  - Shared with the team: every member runs it, at team rules. No approval.
 *  - Submitted: frozen (no code edit, its data read only) until an admin
 *    accepts or rejects it. The author may recall it.
 *  - Accepted: re-owned into the brain at the level the admin picks (admin
 *    or team; client and public only later, by an admin, as for any app),
 *    ids unchanged. Its database file and history rows follow by owner; the
 *    files stay where they are (their rows hold the path).
 *  - In the author's trash (access matrix N6, `space_items.deleted_at`): the
 *    author deleted it before Accept. Nothing moves and nothing is removed;
 *    it runs for no one, no admin list shows it, every change but the
 *    restore refuses, and it comes back private.
 *
 * AUTHOR CEILING (A.4): a member's app has `apps.author_level = 'team'`.
 * Every tool broker runs its tools at most at team rules, an admin's run
 * included. Only an admin's accept with the declared tools reviewed
 * (`trustTools`) raises it to admin.
 *
 * The space role has no grant on the app tables, so this module works on
 * the admin pool with the rule written in every query, like the app
 * brokers: the space is always the one the server derived for the calling
 * login (`mantle_personal_space`), never a value from a client, and a write
 * needs the author's own row in a writable state. Every function runs as
 * the system, so a caller inside a viewer scope cannot widen or narrow it.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import {
  appAccessLog,
  appDatabases,
  type AppManifest,
  apps,
  asSystem,
  authUsers,
  type BuildRef,
  db,
  folderHeadIds,
  nodes,
  nodeSnapshots,
  spaceItems,
  spaces,
  type ViewerLevel,
  withDeadlockRetry,
  withHeads,
  withSystemTx,
} from '@mantle/db';
import {
  APPS_ROOT_LABEL,
  createApp,
  deleteApp,
  ensureAppsRoot,
  getApp,
  type AppDetail,
} from './apps';
import { notifyAppNavChanged } from './app-nav';
import { lockAppHistory } from './app-history-lock';
import { projectAppIcon, projectAppTint } from '@mantle/content-core/app-nav';
import type { AppTint } from '@mantle/client-types';
import { dataAccessOf, type AppDataAccess } from './app-data-access';

/** The member a call acts for: their login and their own personal space,
 *  both derived by the server. */
export type SpaceAppAuthor = { loginId: string; spaceId: string };

export type SpaceAppErrorCode =
  | 'not-found'
  | 'frozen'
  | 'unpublished'
  | 'no-build'
  | 'not-submitted'
  | 'not-draft'
  | 'changed'
  | 'deleted'
  | 'not-deleted';

/** A refusal with words for the member or admin. */
export class SpaceAppError extends Error {
  constructor(
    readonly code: SpaceAppErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SpaceAppError';
  }
}

const NOT_FOUND = () =>
  new SpaceAppError('not-found', 'No such app of yours. List your apps with my_app_list.');

function frozenError(reviewState: string): SpaceAppError {
  return new SpaceAppError(
    'frozen',
    reviewState === 'submitted'
      ? 'This app is submitted for review, so it is frozen. Recall it to change it.'
      : 'This app was accepted into the brain; it is no longer yours to change.',
  );
}

/** The states a member may still edit in. */
const EDITABLE: readonly string[] = ['draft', 'returned'];

/** The states a member may move their app to the trash from: every state
 *  before Accept (a submitted one leaves the review queue). */
const DELETABLE: readonly string[] = ['draft', 'returned', 'submitted'];

const IN_TRASH = () =>
  new SpaceAppError(
    'deleted',
    'This app is in your trash (my_app_deleted_list). Bring it back with my_app_undelete first.',
  );

/** Not in the author's trash: every lookup but the trash's own. */
const live = isNull(spaceItems.deletedAt);

const publishedGreen = sql`(${apps.publishedBuild}->>'ok')::boolean is true`;

/**
 * The app's author is still an active MEMBER (team apps hardening, access
 * matrix N2): disabling, demoting or deleting the author stops their apps
 * for everyone, as it stops their team-shared pages (mantle_member_space).
 * A hard delete leaves the author column null, which never matches.
 */
const authorActive = sql`exists (
  select 1 from auth.users u
  where u.id = ${spaceItems.authorLoginId}
    and u.disabled_at is null
    and u.role = 'member'
)`;

/** Runners only read a member's app's data: it is informational, or it is
 *  under review. One rule for the run lookup and the list's pill (M3 audit,
 *  low 4). */
export function spaceAppDataReadOnly(app: { dataReadOnly: boolean; reviewState: string }): boolean {
  return app.dataReadOnly || app.reviewState === 'submitted';
}

/** Make a new app in the author's own space, private, at team ceiling. */
export async function createSpaceApp(
  author: SpaceAppAuthor,
  input: { title: string; description?: string },
): Promise<AppDetail> {
  return asSystem(async () => {
    const app = await createApp(author.spaceId, {
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      inSpace: true,
    });
    await db
      .update(apps)
      .set({ authorLoginId: author.loginId, authorLevel: 'team' })
      .where(eq(apps.nodeId, app.id));
    await db.insert(spaceItems).values({ nodeId: app.id, authorLoginId: author.loginId });
    return app;
  });
}

export type SpaceAppState = {
  id: string;
  title: string;
  sharing: 'private' | 'team';
  reviewState: string;
};

/**
 * The author's own app, or a SpaceAppError: in their space, theirs by its
 * row, not in their trash, and, for `write`, in a state they may edit (draft
 * or returned; a submitted app is frozen until Accept, Return or Recall).
 */
export async function authorSpaceApp(
  author: SpaceAppAuthor,
  appId: string,
  opts: { write?: boolean } = {},
): Promise<SpaceAppState> {
  const [row] = await asSystem(() =>
    db
      .select({
        id: nodes.id,
        title: nodes.title,
        sharing: spaceItems.sharing,
        reviewState: spaceItems.reviewState,
        deletedAt: spaceItems.deletedAt,
      })
      .from(nodes)
      .innerJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
      .where(
        and(
          eq(nodes.id, appId),
          eq(nodes.ownerId, author.spaceId),
          eq(nodes.type, 'app'),
          eq(spaceItems.authorLoginId, author.loginId),
        ),
      )
      .limit(1),
  );
  if (!row) throw NOT_FOUND();
  if (row.deletedAt) throw IN_TRASH();
  if (opts.write && !EDITABLE.includes(row.reviewState)) throw frozenError(row.reviewState);
  return {
    id: row.id,
    title: row.title,
    sharing: row.sharing === 'team' ? 'team' : 'private',
    reviewState: row.reviewState,
  };
}

/**
 * Run one change to the author's own app while holding its state row (M3
 * audit, medium 3): the row is locked FOR UPDATE and must be draft or
 * returned, and stays locked until `fn` is done, so a Submit, a Recall or an
 * admin's Accept waits for the change to finish and never sees half of it,
 * and a change never starts after a Submit. `fn` runs as the system, inside
 * the lock's own transaction (its `db` is that transaction): one connection
 * per change, and the change commits or rolls back with the lock.
 */
export async function withAuthorWrite<T>(
  author: SpaceAppAuthor,
  appId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return asSystem(() =>
    // One transaction on its own connection, with commit and rollback
    // hooks: a file the change writes is cleaned up if the change rolls
    // back (team apps follow-up).
    withSystemTx(async (tx) => {
      const [row] = await tx
        .select({ reviewState: spaceItems.reviewState, deletedAt: spaceItems.deletedAt })
        .from(spaceItems)
        .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
        .where(
          and(
            eq(spaceItems.nodeId, appId),
            eq(nodes.ownerId, author.spaceId),
            eq(nodes.type, 'app'),
            eq(spaceItems.authorLoginId, author.loginId),
          ),
        )
        .for('update', { of: spaceItems })
        .limit(1);
      if (!row) throw NOT_FOUND();
      if (row.deletedAt) throw IN_TRASH();
      if (!EDITABLE.includes(row.reviewState)) throw frozenError(row.reviewState);
      return fn();
    }),
  );
}

/** One app in a member's list: their own, or one a teammate shared. */
export type SpaceAppCard = {
  id: string;
  title: string;
  description: string | null;
  mine: boolean;
  /** The author's name, for a teammate's app. */
  authorName: string | null;
  sharing: 'private' | 'team';
  reviewState: string;
  /** A green published build: it runs. */
  runnable: boolean;
  /** What the viewer may do with its data (the R and R/W pill): its
   *  runners change it unless it is under review. */
  dataAccess: AppDataAccess;
  /** Unpublished changes (a draft or a build not yet published). */
  hasDraft: boolean;
  version: number;
  updatedAt: string;
};

/** The member's own apps (any state before Accept) and the published apps
 *  teammates shared with the team; never one in a trash. */
export async function listSpaceApps(author: SpaceAppAuthor): Promise<SpaceAppCard[]> {
  const rows = await asSystem(() =>
    db
      .select({
        id: nodes.id,
        title: nodes.title,
        ownerId: nodes.ownerId,
        manifest: apps.manifest,
        publishedBuild: apps.publishedBuild,
        hasDraft: sql<boolean>`${apps.draftSource} is not null or ${apps.draftBuild} is not null`,
        version: apps.version,
        updatedAt: nodes.updatedAt,
        dataReadOnly: apps.dataReadOnly,
        authorLoginId: spaceItems.authorLoginId,
        authorName: sql<
          string | null
        >`coalesce(nullif(trim(${authUsers.displayName}), ''), split_part(${authUsers.email}, '@', 1))`,
        sharing: spaceItems.sharing,
        reviewState: spaceItems.reviewState,
      })
      .from(nodes)
      .innerJoin(apps, eq(apps.nodeId, nodes.id))
      .innerJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
      .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
      .leftJoin(authUsers, eq(authUsers.id, spaceItems.authorLoginId))
      .where(
        and(
          eq(nodes.type, 'app'),
          eq(spaces.kind, 'personal'),
          ne(spaceItems.reviewState, 'accepted'),
          live,
          or(
            and(eq(nodes.ownerId, author.spaceId), eq(spaceItems.authorLoginId, author.loginId)),
            and(eq(spaceItems.sharing, 'team'), publishedGreen, authorActive),
          ),
        ),
      )
      .orderBy(desc(nodes.updatedAt))
      .limit(500),
  );
  return rows.map((r) => {
    const mine = r.ownerId === author.spaceId && r.authorLoginId === author.loginId;
    const description = (r.manifest as AppManifest | null)?.description;
    return {
      id: r.id,
      title: r.title,
      description: typeof description === 'string' && description.trim() ? description : null,
      mine,
      authorName: mine ? null : r.authorName,
      sharing: r.sharing === 'team' ? 'team' : 'private',
      reviewState: r.reviewState,
      runnable: !!(r.publishedBuild as BuildRef | null)?.ok,
      dataAccess: dataAccessOf(
        !spaceAppDataReadOnly({
          dataReadOnly: r.dataReadOnly === true,
          reviewState: r.reviewState,
        }),
      ),
      hasDraft: mine ? r.hasDraft === true : false,
      version: r.version,
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

/** Private or shared with the team, by its author, before Accept. Sharing
 *  never changes a level: the app stays in the space. */
export async function setSpaceAppSharing(
  author: SpaceAppAuthor,
  appId: string,
  sharing: 'private' | 'team',
): Promise<SpaceAppState> {
  const app = await authorSpaceApp(author, appId);
  if (app.reviewState === 'accepted') throw NOT_FOUND();
  await asSystem(() =>
    db
      .update(spaceItems)
      .set({ sharing, updatedAt: new Date() })
      .where(and(eq(spaceItems.nodeId, appId), eq(spaceItems.authorLoginId, author.loginId))),
  );
  return { ...app, sharing };
}

/**
 * Submit to an admin: draft or returned -> submitted. The admin reviews the
 * PUBLISHED app, so unpublished changes refuse (publish first), and so does
 * an app with no green published build. The state row is locked first.
 */
export async function submitSpaceApp(
  author: SpaceAppAuthor,
  appId: string,
): Promise<SpaceAppState> {
  await authorSpaceApp(author, appId);
  return asSystem(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          reviewState: spaceItems.reviewState,
          draft: sql<boolean>`${apps.draftSource} is not null or ${apps.draftBuild} is not null`,
          green: publishedGreen,
          version: apps.version,
          title: nodes.title,
          sharing: spaceItems.sharing,
          deletedAt: spaceItems.deletedAt,
        })
        .from(spaceItems)
        .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
        .innerJoin(apps, eq(apps.nodeId, spaceItems.nodeId))
        .where(
          and(
            eq(spaceItems.nodeId, appId),
            eq(nodes.ownerId, author.spaceId),
            eq(spaceItems.authorLoginId, author.loginId),
          ),
        )
        .for('update', { of: spaceItems })
        .limit(1);
      if (!row) throw NOT_FOUND();
      if (row.deletedAt) throw IN_TRASH();
      if (!EDITABLE.includes(row.reviewState)) {
        throw new SpaceAppError('not-draft', 'This app is already submitted.');
      }
      if (row.draft) {
        throw new SpaceAppError(
          'unpublished',
          'This app has unpublished changes. Build and publish it first (my_app_build, my_app_publish), then submit.',
        );
      }
      if (!row.green) {
        throw new SpaceAppError(
          'no-build',
          'This app has no published build yet. Build and publish it first, then submit.',
        );
      }
      const now = new Date();
      await tx
        .update(spaceItems)
        .set({
          reviewState: 'submitted',
          submittedAt: now,
          submittedVersion: row.version,
          updatedAt: now,
        })
        .where(eq(spaceItems.nodeId, appId));
      return {
        id: appId,
        title: row.title,
        sharing: row.sharing === 'team' ? 'team' : 'private',
        reviewState: 'submitted',
      } satisfies SpaceAppState;
    }),
  );
}

/** Take a submitted app back to draft (the author's Recall). */
export async function recallSpaceApp(
  author: SpaceAppAuthor,
  appId: string,
): Promise<SpaceAppState> {
  const app = await authorSpaceApp(author, appId);
  const changed = await asSystem(() =>
    db
      .update(spaceItems)
      .set({ reviewState: 'draft', updatedAt: new Date() })
      .where(
        and(
          eq(spaceItems.nodeId, appId),
          eq(spaceItems.authorLoginId, author.loginId),
          eq(spaceItems.reviewState, 'submitted'),
          live,
        ),
      )
      .returning({ id: spaceItems.nodeId }),
  );
  if (!changed.length) throw new SpaceAppError('not-submitted', 'This app is not submitted.');
  return { ...app, reviewState: 'draft' };
}

// ── The author's trash (access matrix N6, option A) ─────────────────────────
//
// A member deletes their OWN app before Accept, to a trash in their space.
// Nothing moves and nothing is removed: the node, the app row, its database
// file, its history and its activity stay where they are (standing rule:
// app data and app databases are never hard deleted). `deleted_at` is the
// only change, and every lookup in this module that is not the trash's own
// skips a row that has it, so the app runs for no one, no admin list shows
// it, and every change but the restore refuses. No sweep ever empties the
// trash: the nightly app-trash purge only sees apps whose node is gone,
// and the space purge never removes an app.

/** What a delete did to the app's standing, for the author's answer. */
export type SpaceAppDeleted = SpaceAppState & {
  deletedAt: string;
  /** It was shared with the team: teammates no longer run it. */
  wasShared: boolean;
  /** It was waiting for an admin: it left the review queue. */
  wasSubmitted: boolean;
};

/**
 * Move the author's own app to their trash: draft, returned or submitted
 * (an accepted app is the brain's, and is not found here). It becomes
 * private and a draft at once, so a submitted app leaves the review queue
 * and a restore brings it back private, never straight to the team or to
 * an admin. The state row is locked, then the app's history (the order
 * every change takes them), so a Submit, an Accept or a restore of its
 * history never sees half of it.
 */
export async function deleteSpaceApp(
  author: SpaceAppAuthor,
  appId: string,
): Promise<SpaceAppDeleted> {
  return asSystem(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          title: nodes.title,
          sharing: spaceItems.sharing,
          reviewState: spaceItems.reviewState,
          deletedAt: spaceItems.deletedAt,
        })
        .from(spaceItems)
        .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
        .where(
          and(
            eq(spaceItems.nodeId, appId),
            eq(nodes.ownerId, author.spaceId),
            eq(nodes.type, 'app'),
            eq(spaceItems.authorLoginId, author.loginId),
          ),
        )
        .for('update', { of: spaceItems })
        .limit(1);
      await lockAppHistory(tx, appId);
      if (!row) throw NOT_FOUND();
      if (row.deletedAt) {
        throw new SpaceAppError(
          'deleted',
          'This app is already in your trash (my_app_deleted_list); my_app_undelete brings it back.',
        );
      }
      if (!DELETABLE.includes(row.reviewState)) throw frozenError(row.reviewState);
      const now = new Date();
      await tx
        .update(spaceItems)
        .set({ deletedAt: now, sharing: 'private', reviewState: 'draft', updatedAt: now })
        .where(eq(spaceItems.nodeId, appId));
      return {
        id: appId,
        title: row.title,
        sharing: 'private',
        reviewState: 'draft',
        deletedAt: now.toISOString(),
        wasShared: row.sharing === 'team',
        wasSubmitted: row.reviewState === 'submitted',
      } satisfies SpaceAppDeleted;
    }),
  );
}

/**
 * Bring the author's own app back from their trash: private, a draft, with
 * everything it had (code, builds, data, history), as it was before the
 * delete but for who runs it. Sharing it with the team or submitting it
 * again is the author's own next step.
 */
export async function undeleteSpaceApp(
  author: SpaceAppAuthor,
  appId: string,
): Promise<SpaceAppState> {
  const [row] = await asSystem(() =>
    db
      .update(spaceItems)
      .set({ deletedAt: null, sharing: 'private', reviewState: 'draft', updatedAt: new Date() })
      .where(
        and(
          eq(spaceItems.nodeId, appId),
          eq(spaceItems.authorLoginId, author.loginId),
          isNotNull(spaceItems.deletedAt),
          inArray(
            spaceItems.nodeId,
            db
              .select({ id: nodes.id })
              .from(nodes)
              .where(
                and(eq(nodes.id, appId), eq(nodes.ownerId, author.spaceId), eq(nodes.type, 'app')),
              ),
          ),
        ),
      )
      .returning({ id: spaceItems.nodeId }),
  );
  if (!row) {
    // Live and theirs: say so; anything else is not theirs to restore.
    const app = await authorSpaceApp(author, appId);
    throw new SpaceAppError(
      'not-deleted',
      `"${app.title}" is not in your trash; it is one of your apps (my_app_list).`,
    );
  }
  return authorSpaceApp(author, appId);
}

/** One app in the author's trash. */
export type DeletedSpaceApp = {
  id: string;
  title: string;
  description: string | null;
  deletedAt: string;
  version: number;
  /** It had a green published build: it runs again for its author once
   *  restored. */
  published: boolean;
  /** Its database is kept (it had one). */
  hasData: boolean;
};

/** The author's own apps in their trash, newest delete first. Nothing in it
 *  expires. */
export async function listDeletedSpaceApps(author: SpaceAppAuthor): Promise<DeletedSpaceApp[]> {
  const rows = await asSystem(() =>
    db
      .select({
        id: nodes.id,
        title: nodes.title,
        manifest: apps.manifest,
        version: apps.version,
        publishedBuild: apps.publishedBuild,
        deletedAt: spaceItems.deletedAt,
        hasData: sql<boolean>`exists (
          select 1 from app_databases d where d.app_node_id = ${nodes.id}
        )`,
      })
      .from(nodes)
      .innerJoin(apps, eq(apps.nodeId, nodes.id))
      .innerJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
      .where(
        and(
          eq(nodes.ownerId, author.spaceId),
          eq(nodes.type, 'app'),
          eq(spaceItems.authorLoginId, author.loginId),
          isNotNull(spaceItems.deletedAt),
        ),
      )
      .orderBy(desc(spaceItems.deletedAt))
      .limit(500),
  );
  return rows.map((r) => {
    const description = (r.manifest as AppManifest | null)?.description;
    return {
      id: r.id,
      title: r.title,
      description: typeof description === 'string' && description.trim() ? description : null,
      deletedAt: (r.deletedAt as Date).toISOString(),
      version: r.version,
      published: !!(r.publishedBuild as BuildRef | null)?.ok,
      hasData: r.hasData === true,
    };
  });
}

// ── Running a member's app ───────────────────────────────────────────────────

/** A member's app that this member may run: their own, or one a teammate
 *  shared with the team. Published only. */
export type RunnableSpaceApp = {
  id: string;
  title: string;
  icon: string | null;
  color: AppTint | null;
  /** The app's owner: the author's personal space (its database is keyed
   *  to it). */
  ownerId: string;
  manifest: AppManifest;
  publishedBuild: BuildRef;
  /** Informational, or frozen for review: runners only read its data. */
  dataReadOnly: boolean;
  mine: boolean;
  reviewState: string;
};

/**
 * One member's app this member may run, or null: theirs, or shared with
 * the team by a teammate, with a green published build, not yet accepted
 * (an accepted app is the brain's and runs by its level), not in its
 * author's trash. A submitted app runs read only (it is under review).
 */
export async function getRunnableSpaceApp(
  loginId: string,
  appId: string,
): Promise<RunnableSpaceApp | null> {
  const [row] = await asSystem(() =>
    db
      .select({
        id: nodes.id,
        title: nodes.title,
        data: nodes.data,
        ownerId: nodes.ownerId,
        manifest: apps.manifest,
        publishedBuild: apps.publishedBuild,
        dataReadOnly: apps.dataReadOnly,
        authorLoginId: spaceItems.authorLoginId,
        reviewState: spaceItems.reviewState,
      })
      .from(nodes)
      .innerJoin(apps, eq(apps.nodeId, nodes.id))
      .innerJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
      .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
      .where(
        and(
          eq(nodes.id, appId),
          eq(nodes.type, 'app'),
          eq(spaces.kind, 'personal'),
          ne(spaceItems.reviewState, 'accepted'),
          live,
          or(eq(spaceItems.authorLoginId, loginId), eq(spaceItems.sharing, 'team')),
          authorActive,
          publishedGreen,
        ),
      )
      .limit(1),
  );
  if (!row?.publishedBuild?.ok) return null;
  const d = (row.data ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    title: row.title,
    icon: projectAppIcon(d.icon) ?? null,
    color: projectAppTint(d.color) ?? null,
    ownerId: row.ownerId,
    manifest: row.manifest ?? {},
    publishedBuild: row.publishedBuild,
    dataReadOnly: spaceAppDataReadOnly({
      dataReadOnly: row.dataReadOnly === true,
      reviewState: row.reviewState,
    }),
    mine: row.authorLoginId === loginId,
    reviewState: row.reviewState,
  };
}

// ── The admin's review ───────────────────────────────────────────────────────

/**
 * What the admin reviews, pinned (M3 audit, high 1): a hash of the
 * published source, the manifest (declared tools, schema) and the published
 * build. Accept sends it back with the version; the locked accept refuses
 * when either moved, so only the code the admin read can enter the brain.
 */
export function spaceAppReviewHash(app: {
  source: unknown;
  manifest: unknown;
  publishedBuild: unknown;
}): string {
  return createHash('sha256')
    .update(stableJson({ s: app.source, m: app.manifest, b: app.publishedBuild }))
    .digest('hex');
}

/** JSON with object keys sorted, so the same value always hashes the same. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** The levels an admin may accept a member's app at. Client and public come
 *  later, by an admin, as for any app (Settings or access_set). */
export type SpaceAppAcceptLevel = Extract<ViewerLevel, 'admin' | 'team'>;

/**
 * Accept a submitted member app into the brain (an admin's act): re-own its
 * node to the brain at `level`, ids unchanged; its database registry and
 * history rows follow by owner (the files stay where their rows say). With
 * `trustTools` the admin has reviewed the declared tools and lifts the
 * author ceiling to admin; without it the app keeps running its tools at
 * team rules, whoever runs it. One transaction; the state row is locked.
 */
export async function acceptSpaceApp(
  brainId: string,
  appId: string,
  reviewer: { loginId: string },
  opts: {
    level: SpaceAppAcceptLevel;
    trustTools: boolean;
    /** The version and the review hash the admin was shown
     *  (`getMemberAppForReview`). */
    version: number;
    reviewHash: string;
  },
): Promise<{ id: string; level: SpaceAppAcceptLevel; authorLevel: 'admin' | 'team' }> {
  await asSystem(() => ensureAppsRoot(brainId));
  // Heads first (plan U1): the app (it moves into the brain) and the brain
  // folder it lands in, before the state row and the history lock.
  const heads = [
    appId,
    ...(await folderHeadIds(brainId, [{ type: 'app', path: APPS_ROOT_LABEL }])),
  ];
  const done = await asSystem(() =>
    withDeadlockRetry(() =>
      withHeads(heads, 'update', async (tx) => {
        const [row] = await tx
          .select({
            spaceId: nodes.ownerId,
            reviewState: spaceItems.reviewState,
            submittedVersion: spaceItems.submittedVersion,
            version: apps.version,
            source: apps.source,
            manifest: apps.manifest,
            publishedBuild: apps.publishedBuild,
            draft: sql<boolean>`${apps.draftSource} is not null or ${apps.draftBuild} is not null`,
          })
          .from(spaceItems)
          .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
          .innerJoin(apps, eq(apps.nodeId, spaceItems.nodeId))
          .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
          .where(
            and(
              eq(spaceItems.nodeId, appId),
              eq(nodes.type, 'app'),
              eq(spaces.kind, 'personal'),
              live,
            ),
          )
          .for('update', { of: spaceItems })
          .limit(1);
        // Then the app's history lock (team apps follow-up), in the order a
        // member's change takes them (state row, then history): a member's
        // restore holds it while it works and re-checks the owner under it,
        // so it never lands on the app after this moves it to the brain.
        await lockAppHistory(tx, appId);
        if (!row) throw new SpaceAppError('not-found', 'No such member app.');
        if (row.reviewState !== 'submitted') {
          throw new SpaceAppError('not-submitted', 'This app is not waiting for review.');
        }
        // Only the version the admin read (M3 audit, high 1): the version it
        // was submitted at, the one the admin was shown, and the same code,
        // tools and build. No pending change either (medium 3).
        const shown =
          row.version === opts.version &&
          row.submittedVersion === opts.version &&
          spaceAppReviewHash({
            source: row.source,
            manifest: row.manifest,
            publishedBuild: row.publishedBuild,
          }) === opts.reviewHash;
        if (!shown || row.draft) {
          throw new SpaceAppError(
            'changed',
            'This app changed since you opened it. Open it again, read it, then accept.',
          );
        }
        const now = new Date();
        const authorLevel = opts.trustTools ? 'admin' : 'team';
        await tx
          .update(nodes)
          .set({ ownerId: brainId, audience: opts.level, path: APPS_ROOT_LABEL, updatedAt: now })
          .where(eq(nodes.id, appId));
        await tx.update(apps).set({ authorLevel, updatedAt: now }).where(eq(apps.nodeId, appId));
        await tx
          .update(appDatabases)
          .set({ ownerId: brainId, updatedAt: now })
          .where(eq(appDatabases.appNodeId, appId));
        await tx
          .update(nodeSnapshots)
          .set({ ownerId: brainId })
          .where(eq(nodeSnapshots.nodeId, appId));
        // Its activity too (access matrix N3): every call made while it was a
        // member's app, connector writes included, shows on the brain app's
        // Activity tab.
        await tx
          .update(appAccessLog)
          .set({ ownerId: brainId })
          .where(eq(appAccessLog.appNodeId, appId));
        await tx
          .update(spaceItems)
          .set({
            reviewState: 'accepted',
            reviewedBy: reviewer.loginId,
            reviewedAt: now,
            acceptedAt: now,
            updatedAt: now,
          })
          .where(eq(spaceItems.nodeId, appId));
        return { id: appId, level: opts.level, authorLevel } as const;
      }),
    ),
  );
  void notifyAppNavChanged(brainId);
  return done;
}

/**
 * Send a submitted member app back to its author (an admin's act): it
 * returns as `returned`, editable again, and the author may change it and
 * submit it again. No note (decided 2026-10-09: review flows carry no
 * messages; people talk through their own channels), so the old
 * `returned_note` column is neither written nor read here any more.
 */
export async function sendBackSpaceApp(
  appId: string,
  reviewer: { loginId: string },
): Promise<void> {
  const now = new Date();
  const changed = await asSystem(() =>
    db
      .update(spaceItems)
      .set({
        reviewState: 'returned',
        reviewedBy: reviewer.loginId,
        reviewedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(spaceItems.nodeId, appId),
          eq(spaceItems.reviewState, 'submitted'),
          live,
          inArray(
            spaceItems.nodeId,
            db
              .select({ id: nodes.id })
              .from(nodes)
              .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
              .where(and(eq(nodes.type, 'app'), eq(spaces.kind, 'personal'))),
          ),
        ),
      )
      .returning({ id: spaceItems.nodeId }),
  );
  if (!changed.length)
    throw new SpaceAppError('not-submitted', 'This app is not waiting for review.');
}

// ── The admin's view of members' apps (access matrix N2) ─────────────────────

/** What an admin may reach of members' apps: team-shared or submitted, not
 *  yet accepted, not in its author's trash. A private draft stays the
 *  author's alone. */
const adminVisible = and(
  eq(nodes.type, 'app'),
  eq(spaces.kind, 'personal'),
  ne(spaceItems.reviewState, 'accepted'),
  live,
  or(eq(spaceItems.sharing, 'team'), eq(spaceItems.reviewState, 'submitted')),
);

/** One member app an admin may act on (team-shared or submitted), with the
 *  space it lives in, or null. */
export async function adminSpaceApp(
  appId: string,
): Promise<{ id: string; spaceId: string; sharing: string; reviewState: string } | null> {
  const [row] = await asSystem(() =>
    db
      .select({
        id: nodes.id,
        spaceId: nodes.ownerId,
        sharing: spaceItems.sharing,
        reviewState: spaceItems.reviewState,
      })
      .from(nodes)
      .innerJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
      .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
      .where(and(eq(nodes.id, appId), adminVisible))
      .limit(1),
  );
  return row ?? null;
}

/**
 * An admin deletes a member's team-shared or submitted app (access matrix N2)
 * so that it can come back (M4 audit, medium 2). The app, its database, its
 * history and its activity move to the brain first, as an Accept moves them,
 * at admin level; then the normal delete keeps a pre_delete snapshot and the
 * app waits in the brain's trash for APP_TRASH_DAYS, where an admin restores
 * it (as an admin-only app at team rules, as any member-era app comes back).
 * False when the app is not one an admin may act on. Should the delete fail
 * after the move, the app is the brain's, admin only: nothing is lost.
 */
export async function adminDeleteSpaceApp(brainId: string, appId: string): Promise<boolean> {
  await asSystem(() => ensureAppsRoot(brainId));
  // Heads first (plan U1): the app (it moves into the brain) and the brain
  // folder it lands in, before the state row and the history lock.
  const heads = [
    appId,
    ...(await folderHeadIds(brainId, [{ type: 'app', path: APPS_ROOT_LABEL }])),
  ];
  const moved = await asSystem(() =>
    withDeadlockRetry(() =>
      withHeads(heads, 'update', async (tx) => {
        // The state row, then the history lock: the order a member's change
        // takes them (as Accept does), so no member write lands mid-move.
        const [row] = await tx
          .select({ id: spaceItems.nodeId })
          .from(spaceItems)
          .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
          .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
          .where(and(eq(spaceItems.nodeId, appId), adminVisible))
          .for('update', { of: spaceItems })
          .limit(1);
        await lockAppHistory(tx, appId);
        if (!row) return false;
        const now = new Date();
        await tx
          .update(nodes)
          .set({ ownerId: brainId, audience: 'admin', path: APPS_ROOT_LABEL, updatedAt: now })
          .where(eq(nodes.id, appId));
        // A member's app ran at team rules: so does it if it comes back.
        await tx
          .update(apps)
          .set({ authorLevel: 'team', updatedAt: now })
          .where(eq(apps.nodeId, appId));
        await tx
          .update(appDatabases)
          .set({ ownerId: brainId, updatedAt: now })
          .where(eq(appDatabases.appNodeId, appId));
        await tx
          .update(nodeSnapshots)
          .set({ ownerId: brainId })
          .where(eq(nodeSnapshots.nodeId, appId));
        await tx
          .update(appAccessLog)
          .set({ ownerId: brainId })
          .where(eq(appAccessLog.appNodeId, appId));
        // Out of the member's space: the node delete below would cascade it,
        // and until then it is no longer the member's.
        await tx.delete(spaceItems).where(eq(spaceItems.nodeId, appId));
        return true;
      }),
    ),
  );
  if (!moved) return false;
  const deleted = await asSystem(() => deleteApp(brainId, appId, { actor: 'owner' }));
  void notifyAppNavChanged(brainId);
  return deleted;
}

/** An admin stops a member's app reaching the team (access matrix N2): it
 *  goes back to private, its author's alone. False when it was not shared. */
export async function adminUnshareSpaceApp(appId: string): Promise<boolean> {
  const changed = await asSystem(() =>
    db
      .update(spaceItems)
      .set({ sharing: 'private', updatedAt: new Date() })
      .where(
        and(
          eq(spaceItems.nodeId, appId),
          eq(spaceItems.sharing, 'team'),
          ne(spaceItems.reviewState, 'accepted'),
          inArray(
            spaceItems.nodeId,
            db
              .select({ id: nodes.id })
              .from(nodes)
              .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
              .where(and(eq(nodes.type, 'app'), eq(spaces.kind, 'personal'))),
          ),
        ),
      )
      .returning({ id: spaceItems.nodeId }),
  );
  return changed.length > 0;
}

// ── Review in the Apps screen (workspace review pattern, 2026-10-09) ────────
//
// Team admin > App review and > Member apps are gone: an admin meets
// members' apps in /apps, above the brain's own tree, in two lists, and
// opens one in the normal app screen with a banner. Same line as above
// (`adminVisible`): submitted, or shared with the team, never a private
// draft, never the draft source of a visible one.

/** The author as the review lists show them. */
export type ReviewAppAuthor = { loginId: string | null; name: string | null; active: boolean };

/** One app in "Waiting for approval": a member submitted it. */
export type ReviewWaitingApp = {
  id: string;
  title: string;
  icon: string | null;
  color: AppTint | null;
  author: ReviewAppAuthor;
  submittedAt: string | null;
  /** The version the member submitted (the one an Approve accepts). */
  version: number;
};

/** One app in "Shared by members": shared with the team, not submitted. */
export type ReviewSharedApp = {
  id: string;
  title: string;
  icon: string | null;
  color: AppTint | null;
  author: ReviewAppAuthor;
  /** The newest run, tool call or data step, else its last change. */
  lastActivityAt: string;
  runnable: boolean;
};

const authorName = sql<
  string | null
>`coalesce(nullif(trim(${authUsers.displayName}), ''), split_part(${authUsers.email}, '@', 1))`;

/** The two review lists for the Apps screen. Waiting oldest first (the
 *  longest wait on top); shared by newest activity. A submitted app that is
 *  also shared shows once, under Waiting. */
export async function listMemberAppsForReview(): Promise<{
  waiting: ReviewWaitingApp[];
  shared: ReviewSharedApp[];
}> {
  const rows = await asSystem(() =>
    db
      .select({
        id: nodes.id,
        title: nodes.title,
        data: nodes.data,
        updatedAt: nodes.updatedAt,
        version: apps.version,
        publishedBuild: apps.publishedBuild,
        submittedAt: spaceItems.submittedAt,
        submittedVersion: spaceItems.submittedVersion,
        authorLoginId: spaceItems.authorLoginId,
        authorName,
        active: sql<boolean>`${authorActive}`,
        sharing: spaceItems.sharing,
        reviewState: spaceItems.reviewState,
        lastActivityAt: sql<Date | null>`(
          select max(l.created_at) from app_access_log l where l.app_node_id = ${nodes.id}
        )`,
      })
      .from(nodes)
      .innerJoin(apps, eq(apps.nodeId, nodes.id))
      .innerJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
      .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
      .leftJoin(authUsers, eq(authUsers.id, spaceItems.authorLoginId))
      .where(adminVisible)
      .orderBy(desc(nodes.updatedAt))
      .limit(500),
  );
  const face = (data: unknown) => {
    const d = (data ?? {}) as Record<string, unknown>;
    return { icon: projectAppIcon(d.icon) ?? null, color: projectAppTint(d.color) ?? null };
  };
  const author = (r: (typeof rows)[number]): ReviewAppAuthor => ({
    loginId: r.authorLoginId,
    name: r.authorName,
    active: r.active === true,
  });
  const when = (v: Date | string | null): string | null => (v ? new Date(v).toISOString() : null);
  const waiting = rows
    .filter((r) => r.reviewState === 'submitted')
    .map((r) => ({
      id: r.id,
      title: r.title,
      ...face(r.data),
      author: author(r),
      submittedAt: when(r.submittedAt),
      version: r.submittedVersion ?? r.version,
    }))
    .sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? ''));
  const shared = rows
    .filter((r) => r.reviewState !== 'submitted' && r.sharing === 'team')
    .map((r) => ({
      id: r.id,
      title: r.title,
      ...face(r.data),
      author: author(r),
      lastActivityAt: when(r.lastActivityAt) ?? r.updatedAt.toISOString(),
      runnable: !!(r.publishedBuild as BuildRef | null)?.ok,
    }))
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  return { waiting, shared };
}

/** One member app as the admin's app screen shows it: its PUBLISHED source
 *  only (a draft stays the author's), what it declares, and where it stands.
 *  `reviewHash` only while it waits for approval: what an Approve sends
 *  back with `version`. */
export type MemberAppForReview = {
  id: string;
  title: string;
  description: string | null;
  icon: string | null;
  color: AppTint | null;
  /** The author's personal space: the owner its data, history and activity
   *  are keyed to. Server side only; never sent to a browser. */
  spaceId: string;
  author: ReviewAppAuthor;
  sharing: 'private' | 'team';
  reviewState: string;
  version: number;
  submittedAt: string | null;
  updatedAt: string;
  declaredTools: string[];
  /** Informational: runners only read its data. */
  dataReadOnly: boolean;
  runnable: boolean;
  publishedBuild: BuildRef | null;
  manifest: AppManifest;
  entry: string;
  files: Record<string, string>;
  reviewHash: string | null;
};

/** The app, or null when an admin may not reach it (a private draft, an
 *  accepted or a brain app, no such id). */
export async function getMemberAppForReview(appId: string): Promise<MemberAppForReview | null> {
  const [row] = await asSystem(() =>
    db
      .select({
        id: nodes.id,
        title: nodes.title,
        data: nodes.data,
        spaceId: nodes.ownerId,
        updatedAt: nodes.updatedAt,
        version: apps.version,
        manifest: apps.manifest,
        publishedBuild: apps.publishedBuild,
        dataReadOnly: apps.dataReadOnly,
        submittedAt: spaceItems.submittedAt,
        authorLoginId: spaceItems.authorLoginId,
        authorName,
        active: sql<boolean>`${authorActive}`,
        sharing: spaceItems.sharing,
        reviewState: spaceItems.reviewState,
      })
      .from(nodes)
      .innerJoin(apps, eq(apps.nodeId, nodes.id))
      .innerJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
      .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
      .leftJoin(authUsers, eq(authUsers.id, spaceItems.authorLoginId))
      .where(and(eq(nodes.id, appId), adminVisible))
      .limit(1),
  );
  if (!row) return null;
  const app = await asSystem(() => getApp(row.spaceId, appId));
  if (!app) return null;
  const d = (row.data ?? {}) as Record<string, unknown>;
  const m = (row.manifest ?? {}) as AppManifest;
  return {
    id: row.id,
    title: row.title,
    description: typeof m.description === 'string' && m.description.trim() ? m.description : null,
    icon: projectAppIcon(d.icon) ?? null,
    color: projectAppTint(d.color) ?? null,
    spaceId: row.spaceId,
    author: { loginId: row.authorLoginId, name: row.authorName, active: row.active === true },
    sharing: row.sharing === 'team' ? 'team' : 'private',
    reviewState: row.reviewState,
    version: row.version,
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
    declaredTools: m.toolSlugs ?? [],
    dataReadOnly: row.dataReadOnly === true,
    runnable: !!(row.publishedBuild as BuildRef | null)?.ok,
    publishedBuild: (row.publishedBuild as BuildRef | null) ?? null,
    manifest: m,
    // The published source, never `app.draft` (rule S3).
    entry: app.source.entry,
    files: app.source.files,
    reviewHash:
      row.reviewState === 'submitted'
        ? spaceAppReviewHash({
            source: app.source,
            manifest: app.manifest,
            publishedBuild: app.publishedBuild,
          })
        : null,
  };
}
