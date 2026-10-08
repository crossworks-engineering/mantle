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
 *    accepts or returns it. The author may recall it.
 *  - Accepted: re-owned into the brain at the level the admin picks (admin
 *    or team; client and public only later, by an admin, as for any app),
 *    ids unchanged. Its database file and history rows follow by owner; the
 *    files stay where they are (their rows hold the path).
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
import { and, asc, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import {
  appDatabases,
  apps,
  asSystem,
  authUsers,
  db,
  nodeSnapshots,
  nodes,
  spaceItems,
  spaces,
  type AppManifest,
  type BuildRef,
  type ViewerLevel,
} from '@mantle/db';
import { APPS_ROOT_LABEL, createApp, ensureAppsRoot, type AppDetail } from './apps';
import { notifyAppNavChanged } from './app-nav';

/** The member a call acts for: their login and their own personal space,
 *  both derived by the server. */
export type SpaceAppAuthor = { loginId: string; spaceId: string };

export type SpaceAppErrorCode =
  'not-found' | 'frozen' | 'unpublished' | 'no-build' | 'not-submitted' | 'not-draft';

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

/** The states a member may still edit in. */
const EDITABLE: readonly string[] = ['draft', 'returned'];

const publishedGreen = sql`(${apps.publishedBuild}->>'ok')::boolean is true`;

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
  returnedNote: string | null;
};

/**
 * The author's own app, or a SpaceAppError: in their space, theirs by its
 * row, and, for `write`, in a state they may edit (draft or returned; a
 * submitted app is frozen until Accept, Return or Recall).
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
        returnedNote: spaceItems.returnedNote,
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
  if (opts.write && !EDITABLE.includes(row.reviewState)) {
    throw new SpaceAppError(
      'frozen',
      row.reviewState === 'submitted'
        ? 'This app is submitted for review, so it is frozen. Recall it to change it.'
        : 'This app was accepted into the brain; it is no longer yours to change.',
    );
  }
  return { ...row, sharing: row.sharing === 'team' ? 'team' : 'private' };
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
  returnedNote: string | null;
  /** A green published build: it runs. */
  runnable: boolean;
  /** Unpublished changes (a draft or a build not yet published). */
  hasDraft: boolean;
  version: number;
  updatedAt: string;
};

/** The member's own apps (any state before Accept) and the published apps
 *  teammates shared with the team. */
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
        authorLoginId: spaceItems.authorLoginId,
        authorName: sql<
          string | null
        >`coalesce(nullif(trim(${authUsers.displayName}), ''), split_part(${authUsers.email}, '@', 1))`,
        sharing: spaceItems.sharing,
        reviewState: spaceItems.reviewState,
        returnedNote: spaceItems.returnedNote,
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
          or(
            and(eq(nodes.ownerId, author.spaceId), eq(spaceItems.authorLoginId, author.loginId)),
            and(eq(spaceItems.sharing, 'team'), publishedGreen),
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
      returnedNote: mine ? r.returnedNote : null,
      runnable: !!(r.publishedBuild as BuildRef | null)?.ok,
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
        returnedNote: null,
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
        ),
      )
      .returning({ id: spaceItems.nodeId }),
  );
  if (!changed.length) throw new SpaceAppError('not-submitted', 'This app is not submitted.');
  return { ...app, reviewState: 'draft' };
}

// ── Running a member's app ───────────────────────────────────────────────────

/** A member's app that this member may run: their own, or one a teammate
 *  shared with the team. Published only. */
export type RunnableSpaceApp = {
  id: string;
  title: string;
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
 * (an accepted app is the brain's and runs by its level). A submitted app
 * runs read only (it is under review).
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
          or(eq(spaceItems.authorLoginId, loginId), eq(spaceItems.sharing, 'team')),
          publishedGreen,
        ),
      )
      .limit(1),
  );
  if (!row?.publishedBuild?.ok) return null;
  return {
    id: row.id,
    title: row.title,
    ownerId: row.ownerId,
    manifest: row.manifest ?? {},
    publishedBuild: row.publishedBuild,
    dataReadOnly: row.dataReadOnly === true || row.reviewState === 'submitted',
    mine: row.authorLoginId === loginId,
    reviewState: row.reviewState,
  };
}

// ── The admin's review ───────────────────────────────────────────────────────

/** One submitted member app, as the admin reviews it: what it declares. */
export type SpaceAppSubmission = {
  id: string;
  title: string;
  description: string | null;
  author: { loginId: string | null; name: string | null };
  submittedAt: string | null;
  version: number;
  /** The tools the app declares: what it will call. */
  declaredTools: string[];
};

/** The member apps waiting for review, oldest first. */
export async function listSpaceAppSubmissions(): Promise<SpaceAppSubmission[]> {
  const rows = await asSystem(() =>
    db
      .select({
        id: nodes.id,
        title: nodes.title,
        manifest: apps.manifest,
        version: apps.version,
        submittedAt: spaceItems.submittedAt,
        authorLoginId: spaceItems.authorLoginId,
        authorName: sql<
          string | null
        >`coalesce(nullif(trim(${authUsers.displayName}), ''), split_part(${authUsers.email}, '@', 1))`,
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
          eq(spaceItems.reviewState, 'submitted'),
        ),
      )
      .orderBy(asc(spaceItems.submittedAt))
      .limit(200),
  );
  return rows.map((r) => {
    const m = (r.manifest ?? {}) as AppManifest;
    return {
      id: r.id,
      title: r.title,
      description: typeof m.description === 'string' && m.description.trim() ? m.description : null,
      author: { loginId: r.authorLoginId, name: r.authorName },
      submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
      version: r.version,
      declaredTools: m.toolSlugs ?? [],
    };
  });
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
  opts: { level: SpaceAppAcceptLevel; trustTools: boolean },
): Promise<{ id: string; level: SpaceAppAcceptLevel; authorLevel: 'admin' | 'team' }> {
  await asSystem(() => ensureAppsRoot(brainId));
  const done = await asSystem(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .select({ spaceId: nodes.ownerId, reviewState: spaceItems.reviewState })
        .from(spaceItems)
        .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
        .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
        .where(
          and(eq(spaceItems.nodeId, appId), eq(nodes.type, 'app'), eq(spaces.kind, 'personal')),
        )
        .for('update', { of: spaceItems })
        .limit(1);
      if (!row) throw new SpaceAppError('not-found', 'No such member app.');
      if (row.reviewState !== 'submitted') {
        throw new SpaceAppError('not-submitted', 'This app is not waiting for review.');
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
  );
  void notifyAppNavChanged(brainId);
  return done;
}

/** Return a submitted member app to its author with a note (an admin's act). */
export async function returnSpaceApp(
  appId: string,
  reviewer: { loginId: string },
  note: string,
): Promise<void> {
  const now = new Date();
  const changed = await asSystem(() =>
    db
      .update(spaceItems)
      .set({
        reviewState: 'returned',
        returnedNote: note.trim().slice(0, 2000) || null,
        reviewedBy: reviewer.loginId,
        reviewedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(spaceItems.nodeId, appId),
          eq(spaceItems.reviewState, 'submitted'),
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
