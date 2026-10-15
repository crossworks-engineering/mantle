/**
 * A login's own mini apps after the spaces fold (workspaces W6b, plan 15
 * and 21.8 row 7): they are brain apps like any other, homed in a
 * workspace, under the normal grant rules. The member app tools
 * (`my_app_*`, builtins-my-apps.ts) read and change them through here:
 *
 *  - an app is the login's to read when its scope reads it, to change when
 *    the login may edit it (mantle_may_edit: a Moderator of its home, or a
 *    grant with Write on), to delete when it may manage it (a Moderator of
 *    its home); asked in the login's own scope, never on the system pool;
 *  - a new app is homed in the login's private workspace ("only you", made
 *    on its first need), at team rules (the author ceiling);
 *  - a delete is the brain's delete (its pre_delete snapshot keeps code and
 *    data; the brain's trash brings it back); the trash lists the deleted
 *    apps whose home the login moderates.
 *
 * The app work itself (files, builds, schema, snapshots) runs as the system
 * after the check, as the app brokers do; the caller leaves its turn scope
 * by the 'app-data' door for exactly that.
 */
import { and, eq, sql } from 'drizzle-orm';
import { isUuid } from '@mantle/std';
import {
  apps,
  createHomeIntent,
  db,
  itemHomeSql,
  mayEditSql,
  mayManageHomeInSql,
  mayManageSql,
  snapshotHomeSql,
  wsArraySql,
  withCreateHome,
  withViewer,
  type AppManifest,
} from '@mantle/db';
import { createApp, deleteApp, type AppDetail } from './apps';
import { listDeletedApps, restoreDeletedApp, type DeletedApp } from './app-trash';

/** The login the member app tools act for, and its brain. */
export type MemberAppAuthor = { loginId: string; brainId: string };

/** A refusal the tools answer as is (its message says what to do). */
export class MemberAppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemberAppError';
  }
}

const notFound = (id: string) =>
  new MemberAppError(`No app ${id} you can see. List your apps with my_app_list.`);

/** One app as the login sees it. */
export type MemberAppState = {
  id: string;
  title: string;
  /** Its home workspace. */
  home: string | null;
  mayEdit: boolean;
  mayManage: boolean;
};

/**
 * The app, checked in the login's scope: it reads it, and for `write` may
 * edit it, for `manage` may manage it (delete). A MemberAppError otherwise.
 */
export async function memberApp(
  author: MemberAppAuthor,
  appId: string,
  opts: { write?: boolean; manage?: boolean; edit?: boolean } = {},
): Promise<MemberAppState> {
  const rows = (await withViewer({ login: author.loginId }, () =>
    db.execute(sql`
      select n.id::text as id, n.title, ${itemHomeSql('n')}::text as home,
             ${mayEditSql('n')} as edit, ${mayManageSql('n')} as manage
        from nodes n
       where n.id = ${appId} and n.owner_id = ${author.brainId} and n.type = 'app'`),
  )) as unknown as {
    id: string;
    title: string;
    home: string | null;
    edit: boolean;
    manage: boolean;
  }[];
  const row = rows[0];
  if (!row) throw notFound(appId);
  if (opts.write && !row.edit) {
    throw new MemberAppError(
      `You may run app ${appId} but not change it: it lives in a workspace where you are not a Moderator and its grant has Write off. Ask a Moderator of that workspace.`,
    );
  }
  if (opts.edit && !row.edit) {
    throw new MemberAppError(
      `You may run app ${appId} but not read its errors: only a login that may change it does (a Moderator of the workspace it lives in, or a grant with Write on).`,
    );
  }
  if (opts.manage && !row.manage) {
    throw new MemberAppError(
      `Only a Moderator of the workspace app ${appId} lives in can delete it.`,
    );
  }
  return {
    id: row.id,
    title: row.title,
    home: row.home,
    mayEdit: row.edit,
    mayManage: row.manage,
  };
}

/** Run one change to an app the login may edit (checked first). */
export async function withMemberAppWrite<T>(
  author: MemberAppAuthor,
  appId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await memberApp(author, appId, { write: true });
  return fn();
}

/** One app in the login's list. */
export type LoginAppCard = {
  id: string;
  title: string;
  description: string | null;
  /** The login may change it (a Moderator of its home, or Write on). */
  mine: boolean;
  /** Its home workspace's name. */
  home: string | null;
  /** In its author's trash when the spaces were folded (W6b): kept, live
   *  in the private workspace only, for the author to delete or keep. */
  trashedBeforeFold: boolean;
  runnable: boolean;
  hasDraft: boolean;
  version: number;
  updatedAt: string;
};

/** The apps the login's scope reads, newest first: its own first. */
export async function listLoginApps(author: MemberAppAuthor): Promise<LoginAppCard[]> {
  const rows = (await withViewer({ login: author.loginId }, () =>
    db.execute(sql`
      select n.id::text as id, n.title, n.updated_at,
             coalesce((n.data->>'trashedBeforeFold')::boolean, false) as trashed,
             w.name as home,
             ${mayEditSql('n')} as edit,
             a.manifest, (a.published_build->>'ok')::boolean is true as runnable,
             (a.draft_source is not null or a.draft_build is not null) as has_draft,
             a.version
        from nodes n
        join apps a on a.node_id = n.id
        left join workspaces w on w.id = ${itemHomeSql('n')}
       where n.owner_id = ${author.brainId} and n.type = 'app'
       order by n.updated_at desc
       limit 500`),
  )) as unknown as {
    id: string;
    title: string;
    updated_at: Date | string;
    trashed: boolean;
    home: string | null;
    edit: boolean;
    manifest: AppManifest | null;
    runnable: boolean;
    has_draft: boolean;
    version: number;
  }[];
  return rows
    .map((r) => {
      const description = r.manifest?.description;
      return {
        id: r.id,
        title: r.title,
        description: typeof description === 'string' && description.trim() ? description : null,
        mine: r.edit,
        home: r.home,
        trashedBeforeFold: r.trashed,
        runnable: r.runnable,
        hasDraft: r.edit ? r.has_draft : false,
        version: Number(r.version),
        updatedAt: new Date(r.updated_at).toISOString(),
      };
    })
    .sort((a, b) => Number(b.mine) - Number(a.mine));
}

/** The login's private workspace, made on its first need; null when the
 *  brain is not on workspaces or the login cannot have one. Through
 *  createHomeIntent, the one path that makes and reads it (the login
 *  write gateway then seats the login as its Moderator, A2b2b). */
export async function memberPrivateWorkspace(author: MemberAppAuthor): Promise<string | null> {
  const home = await createHomeIntent(author.loginId, null, { ownWork: true, makePrivate: true });
  return 'refused' in home ? null : home.privateWs;
}

/** A new app of the login's, homed in its private workspace, private and
 *  at team rules (the author ceiling). */
export async function createMemberApp(
  author: MemberAppAuthor,
  input: { title: string; description?: string },
): Promise<AppDetail> {
  const privateWs = await memberPrivateWorkspace(author);
  if (!privateWs) {
    throw new MemberAppError('You have no workspace to make an app in yet. Ask an admin.');
  }
  const app = await withCreateHome({ createWs: privateWs, privateWs }, () =>
    createApp(author.brainId, {
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      authorLevel: 'team',
    }),
  );
  await db
    .update(apps)
    .set({ authorLoginId: author.loginId, authorLevel: 'team' })
    .where(and(eq(apps.nodeId, app.id)));
  return app;
}

/** Delete an app the login manages: the brain's delete (its snapshot keeps
 *  code and data for the trash). */
export async function deleteMemberApp(
  author: MemberAppAuthor,
  appId: string,
): Promise<{ id: string; title: string; deletedAt: string }> {
  const state = await memberApp(author, appId, { manage: true });
  // A member's delete waits in the trash for the brain's owner (CEO
  // decision 1, W6b fix round 1): the nightly purge never removes it.
  const done = await deleteApp(author.brainId, appId, {
    actor: 'member',
    deletedBy: { loginId: author.loginId, owner: false },
  });
  if (!done) throw notFound(appId);
  return { id: state.id, title: state.title, deletedAt: new Date().toISOString() };
}

/** The deleted apps whose home the login moderates (their pre_delete
 *  snapshot names it), newest first. */
export async function listDeletedMemberApps(
  author: MemberAppAuthor,
): Promise<(DeletedApp & { home: string })[]> {
  const homes = await deletedHomes(author);
  return (await listDeletedApps(author.brainId))
    .filter((d) => homes.has(d.id))
    .map((d) => ({ ...d, home: homes.get(d.id)! }));
}

/** Deleted app id to its home, for the homes the login moderates. */
async function deletedHomes(author: MemberAppAuthor): Promise<Map<string, string>> {
  const rows = (await db.execute(sql`
    select distinct on (s.node_id) s.node_id::text as id, ${snapshotHomeSql('s')} as home
      from node_snapshots s
     where s.owner_id = ${author.brainId} and s.node_kind = 'app' and s.trigger = 'pre_delete'
       and not exists (select 1 from nodes n where n.id = s.node_id)
     order by s.node_id, s.seq desc`)) as unknown as { id: string; home: string | null }[];
  // The homes the login may manage, by the rule (mantle_may_manage in its
  // scope; arch A6), not by a hand comparison with its Moderator list. A
  // stored home that is no id is no workspace: nobody manages it.
  const homes = [...new Set(rows.map((r) => r.home).filter((h): h is string => isUuid(h)))];
  const managed = homes.length
    ? ((await withViewer({ login: author.loginId }, () =>
        db.execute(sql`select h::text as ws from unnest(${wsArraySql(homes)}) as h(h)
                        where ${mayManageHomeInSql(sql`h.h`, sql`"public"."mantle_scope_mod_ws"()`)}`),
      )) as unknown as { ws: string }[])
    : [];
  const may = new Set(managed.map((r) => r.ws));
  const out = new Map<string, string>();
  for (const r of rows) if (r.home && may.has(r.home)) out.set(r.id, r.home);
  return out;
}

/** Bring a deleted app back into its home (the login moderates it). */
export async function undeleteMemberApp(
  author: MemberAppAuthor,
  appId: string,
): Promise<{ id: string; title: string }> {
  const home = (await deletedHomes(author)).get(appId);
  if (!home) {
    throw new MemberAppError(
      `No app ${appId} in a trash you may restore from. List them with my_app_deleted_list.`,
    );
  }
  const back = await withCreateHome({ createWs: home, privateWs: null }, () =>
    restoreDeletedApp(author.brainId, appId, { actor: 'member' }),
  );
  if (!back) throw notFound(appId);
  return back;
}
