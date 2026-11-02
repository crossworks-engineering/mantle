/**
 * A Present canvas's open link is its home Moderators', as an app's
 * (owner decision 2026-11-02; the registry's `publicLink: 'moderator'`,
 * linkNeedsModerator), on a real, migrated database:
 *
 *  - a login who may edit the canvas (a Write grant) but does not moderate
 *    its home is refused by assertMayLink, in the words that name the rule,
 *    while it may still link a note it edits the same way;
 *  - a Moderator of the canvas's home may;
 *  - the Grant Access panel offers the link to the Moderator only (mayLink);
 *  - a change to the link (/api/shares/:id) is refused to the editor;
 *  - a link made before stays live and still serves the canvas.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/present-link-moderator.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)("a canvas's link is its home Moderators'", () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | null = null;
  let m: typeof import('@mantle/db');
  let content: typeof import('@mantle/content');
  let g: typeof import('@/lib/grants');
  let answers: typeof import('@/lib/auth/item-answers');
  let shares: typeof import('@/lib/shares');

  const L = { owner: randomUUID(), modP: randomUUID(), userQ: randomUUID() };
  const W = { P: randomUUID(), Q: randomUUID() };
  const I = { cv: randomUUID(), note: randomUUID(), app: randomUUID() };
  const share = { id: randomUUID(), token: `plm-${randomUUID()}` };
  type Who = keyof typeof L;

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);

  const callerOf = (who: Who) =>
    who === 'owner'
      ? {
          kind: 'admin' as const,
          loginId: L.owner,
          anchorId: L.owner,
          user: {
            id: L.owner,
            email: 'owner@example.invalid',
            actor: {
              id: L.owner,
              email: 'owner@example.invalid',
              displayName: 'owner',
              isOwner: true,
            },
          },
        }
      : { kind: 'member' as const, loginId: L[who], anchorId: L.owner, user: null };

  /** As a route runs it: in a request slot, in the login's own scope. */
  const asLogin = async <T>(who: Who, fn: () => Promise<T>): Promise<T> => {
    const scope = await m.viewerScopeFor({ login: L[who] });
    return m.runInRequestSlot(async () => {
      expect(m.enterRequestScope(scope, { writes: false, drafts: who === 'owner' })).toBe(true);
      return fn();
    });
  };

  /** The refusal assertMayLink throws, or 'ok'. */
  const mayLink = async (who: Who, id: string) => {
    try {
      await content.assertMayLink(L.owner, L[who], id);
      return 'ok';
    } catch (err) {
      const e = err as { status?: number; message?: string };
      return { status: e.status, message: e.message };
    }
  };

  const node = async (id: string, type: string, title: string, path: string) => {
    await x(sql`insert into nodes (id, owner_id, type, title, path)
                values (${id}, ${L.owner}, ${type}::node_type, ${title}, ${path}::ltree)`);
    // Homed in P, granted to Q with Write on: userQ edits it, modP moderates it.
    await m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${id}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${id}, ${W.P}, true)`);
    });
    await m.withSubtreeHeads(id, [], async (tx) => {
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, write)
                           values (${id}, ${W.Q}, true)`);
    });
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET ??= 'present-link-moderator-secret-at-least-32-chars';
    m = await import('@mantle/db');
    content = await import('@mantle/content');
    g = await import('@/lib/grants');
    answers = await import('@/lib/auth/item-answers');
    shares = await import('@/lib/shares');

    for (const who of Object.keys(L) as Who[]) {
      await ts.asSuperuser()(sql`
        insert into auth.users (id, email, password_hash, is_owner, role, display_name)
        values (${L[who]}, ${`plm-${who}@example.invalid`}, 'x', ${who === 'owner'},
                ${who === 'owner' ? 'admin' : 'member'}, ${who})`);
    }
    await x(sql`insert into spaces (id, kind, login_id) values (${L.owner}, 'brain', ${L.owner})
                on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch(scratch.url);
    await su(sql`insert into workspaces (id, owner_id, name) values
      (${W.P}, ${L.owner}, 'Proj'), (${W.Q}, ${L.owner}, 'Quay')`);
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${W.P}, ${L.modP}, true), (${W.Q}, ${L.userQ}, false)`);

    await node(I.cv, 'present', 'Pump deck', 'present');
    await node(I.note, 'note', 'A note', 'notes');
    await node(I.app, 'app', 'An app', 'apps');
    // A link made before the rule (by the owner): it stays live.
    await x(sql`insert into shares (id, token, owner_id, node_id, node_type)
                values (${share.id}, ${share.token}, ${L.owner}, ${I.cv}, 'present')`);
  }, 120_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  it('the registry names the rule once: an app and a canvas', () => {
    expect(content.linkNeedsModerator('present')).toBe(true);
    expect(content.linkNeedsModerator('app')).toBe(true);
    expect(content.linkNeedsModerator('note')).toBe(false);
    expect(content.linkNeedsModerator('page')).toBe(false);
    // A canvas still carries a link at all.
    expect(content.canShareNode({ type: 'present', path: 'present' })).toBe(true);
  });

  it('an editor who does not moderate the home is refused, in the words of the rule', async () => {
    const refused = { status: 403, message: content.LINK_NO_MANAGE_MESSAGE };
    expect(await mayLink('userQ', I.cv)).toEqual(refused);
    expect(await mayLink('userQ', I.app)).toEqual(refused);
    // The same login links a note it edits the same way.
    expect(await mayLink('userQ', I.note)).toBe('ok');
    expect(content.LINK_NO_MANAGE_MESSAGE).toContain('Moderator');
    expect(content.LINK_NO_MANAGE_MESSAGE).toContain('Present canvas');
  });

  it('a Moderator of the home may', async () => {
    expect(await mayLink('modP', I.cv)).toBe('ok');
  });

  it("the database's edit check names the same kinds (mantle_link_needs_manage, 0352)", async () => {
    const { ITEM_KIND_NAMES, linkNeedsModerator } = await import('@mantle/client-types/kinds');
    const rows = await x<{ k: string; manage: boolean }>(
      sql`select k::text as k, mantle_link_needs_manage(k) as manage
            from unnest(enum_range(null::node_type)) k`,
    );
    expect(rows.length).toBe(ITEM_KIND_NAMES.length);
    for (const r of rows) expect(r.manage, r.k).toBe(linkNeedsModerator(r.k));
    expect(
      rows
        .filter((r) => r.manage)
        .map((r) => r.k)
        .sort(),
    ).toEqual(['app', 'present']);
  });

  it('the Grant Access panel offers the link to the Moderator only', async () => {
    const editor = await asLogin('userQ', () => g.getGrants(callerOf('userQ'), I.cv));
    expect(editor.mayLink).toBe(false);
    // An editor may not open the link, so the panel sends none.
    expect(editor.link).toBeNull();
    const mod = await asLogin('modP', () => g.getGrants(callerOf('modP'), I.cv));
    expect(mod.mayLink).toBe(true);
    expect(mod.link?.id).toBe(share.id);
  });

  it('a change to the link is refused to the editor, not to the Moderator', async () => {
    const editor = await asLogin('userQ', () => answers.shareItemRefusal(share.id));
    expect(editor?.status).toBe(403);
    expect(await asLogin('modP', () => answers.shareItemRefusal(share.id))).toBeNull();
  });

  it('a link made before stays live and still serves the canvas', async () => {
    const row = await shares.resolveActiveShareRowByToken(share.token);
    expect(row?.nodeId).toBe(I.cv);
    expect(await shares.loadShareView(row!)).toEqual({
      kind: 'present',
      presentId: I.cv,
      title: 'Pump deck',
    });
  });
});
