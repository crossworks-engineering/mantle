/**
 * The workspace delegates reach every workspace assistant ONCE (owner
 * decision 2026-10-26: a workspace's assistant may hand work to Draftsman,
 * Presenter and Appsmith; reconcileWorkspaceDelegation), on one migrated
 * scratch database, switched to workspaces:
 *
 *  - the assistant of a workspace other than Admin and the Team responder
 *    held by one gain the `delegation` group and the three slugs in their
 *    delegate_to, keeping every group and delegate they had;
 *  - Admin's persona, a responder on no workspace, a disabled assistant and
 *    a specialist gain nothing;
 *  - a second run changes nothing (idempotent);
 *  - an owner who removes the group or a delegate after the grant keeps it
 *    removed: the next whole reconcile (reconcileOwner, the specialist
 *    union too) does not add it back;
 *  - a delegate the brain did not have is granted once its agent exists
 *    (provisioned by the reconcile); an assistant made later gets them once;
 *  - the ids of deleted agents leave the record.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/system-manifest/workspace-delegation.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const THREE = ['diagrammer', 'presenter', 'appsmith'];

describe.skipIf(!URL)(
  'every workspace assistant may delegate to the workspace delegates, once',
  () => {
    type Ts = typeof import('@mantle/db/test-support');
    let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
    let m: typeof import('@mantle/db');
    let rec: typeof import('./reconcile');
    const owner = randomUUID();
    const tag = `wdg${randomUUID().slice(0, 6)}`;
    const ids: Record<string, string> = {};
    let adminWs = '';
    let otherWs = '';

    const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
      (await m.systemDb.execute(q)) as unknown as T[];
    const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
      (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
    const agent = async (
      key: string,
      opts: {
        role: string;
        workspaceId: string | null;
        groups: string[];
        delegateTo?: string[];
        slug?: string;
        enabled?: boolean;
      },
    ) => {
      const groups = `{${opts.groups.join(',')}}`;
      const mc = JSON.stringify({ max_iterations: 7, delegate_to: opts.delegateTo ?? [] });
      const [row] = await x<{ id: string }>(sql`
      insert into agents (owner_id, slug, name, model, provider, system_prompt, role, audience,
                          workspace_id, tool_group_slugs, memory_config, enabled)
      values (${owner}, ${opts.slug ?? `${tag}-${key}`}, ${key}, 'fake/model', 'local', 'x',
              ${opts.role}, 'admin', ${opts.workspaceId}, ${groups}::text[], ${mc}::jsonb,
              ${opts.enabled ?? true})
      returning id::text as id`);
      ids[key] = row!.id;
    };
    const rowOf = async (key: string) =>
      (
        await x<{ g: string[]; mc: { delegate_to?: string[]; max_iterations?: number } }>(sql`
        select tool_group_slugs as g, memory_config as mc from agents where id = ${ids[key]}`)
      )[0]!;
    const granted = async () =>
      ((
        await x<{ g: Record<string, string[]> | null }>(sql`
        select preferences->'workspaceDelegationGranted' as g from profiles where user_id = ${owner}`)
      )[0]?.g ?? {}) as Record<string, string[]>;

    beforeAll(async () => {
      const ts: Ts = await import('@mantle/db/test-support');
      scratch = await ts.createMigratedScratchDatabase(URL!);
      process.env.DATABASE_URL = scratch.url;
      process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
      m = await import('@mantle/db');
      rec = await import('./reconcile');
      await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner')`);
      await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
      // The key a provisioned brain has (reconcileOwner provisions specialists).
      await x(sql`insert into api_keys (id, user_id, service, label, key_enc)
      values (${randomUUID()}, ${owner}, 'openrouter', 'default', '\\x00'::bytea)`);
      await ts.runWorkspacesSwitch();
      adminWs = (
        await x<{ id: string }>(sql`select id::text as id from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)
      )[0]!.id;
      otherWs = (
        await su<{ id: string }>(sql`insert into workspaces (owner_id, name)
        values (${owner}, ${`${tag} other`}) returning id::text as id`)
      )[0]!.id;
      // The specialists the brain has (Appsmith comes later).
      for (const slug of ['diagrammer', 'presenter', 'toolsmith']) {
        await agent(slug, { role: 'custom', workspaceId: null, groups: [], slug });
      }
    }, 240_000);

    afterAll(async () => {
      await m?.closeDb();
      await scratch?.drop();
    });

    it('grants the group and the delegates present to a workspace assistant and the Team responder, add-only', async () => {
      await agent('persona', {
        role: 'responder',
        workspaceId: adminWs,
        groups: ['memory-core', 'delegation'],
        delegateTo: ['researcher'],
      });
      await agent('other', {
        role: 'assistant',
        workspaceId: otherWs,
        groups: ['memory-core', `${tag}-own`],
        delegateTo: ['researcher', 'presenter'],
      });
      await agent('team', {
        role: 'custom',
        workspaceId: otherWs,
        groups: ['team-read'],
        slug: 'team-responder',
      });
      await agent('none', { role: 'responder', workspaceId: null, groups: [] });
      await agent('off', { role: 'assistant', workspaceId: otherWs, groups: [], enabled: false });

      const changes = await rec.reconcileWorkspaceDelegation(owner);
      expect(changes.sort()).toEqual(
        [
          `${tag}-other:+delegation,diagrammer`,
          'team-responder:+delegation,diagrammer,presenter',
        ].sort(),
      );
      const other = await rowOf('other');
      expect(other.g).toEqual(['memory-core', `${tag}-own`, 'delegation']);
      expect(other.mc).toEqual({
        max_iterations: 7,
        delegate_to: ['researcher', 'presenter', 'diagrammer'],
      });
      expect((await rowOf('team')).g).toEqual(['team-read', 'delegation']);
      expect((await rowOf('team')).mc.delegate_to).toEqual(['diagrammer', 'presenter']);
      expect(await rowOf('persona')).toMatchObject({
        g: ['memory-core', 'delegation'],
        mc: { delegate_to: ['researcher'] },
      });
      for (const k of ['none', 'off', 'presenter']) {
        expect((await rowOf(k)).mc.delegate_to, k).toEqual([]);
        expect((await rowOf(k)).g, k).not.toContain('delegation');
      }
      expect((await granted())[ids.other!]).toEqual([
        'group:delegation',
        'delegate:diagrammer',
        'delegate:presenter',
      ]);
      // Idempotent.
      expect(await rec.reconcileWorkspaceDelegation(owner)).toEqual([]);
    });

    it('an owner’s removal sticks through the whole reconcile; a delegate is granted once its agent exists', async () => {
      await x(sql`update agents set tool_group_slugs = array_remove(tool_group_slugs, 'delegation'),
      memory_config = jsonb_set(memory_config, '{delegate_to}', '["researcher"]')
      where id in (${ids.other!}, ${ids.team!})`);
      expect(await rec.reconcileWorkspaceDelegation(owner)).toEqual([]);
      // The whole reconcile: it provisions the specialists the brain misses
      // (Appsmith among them), unions each manifest agent's groups (the Team
      // responder's `delegation` left out: granted once) and grants Appsmith,
      // now present, once; what the owner removed stays removed.
      const r = await rec.reconcileOwner(owner);
      expect(r.provisioned).toContain('appsmith');
      // The provision wires each new specialist into every enabled responder
      // and assistant (wireDelegation), `other` too, so this step has only
      // the Team responder (a custom role) to give Appsmith.
      expect(r.delegationChanges).toEqual(['team-responder:+appsmith']);
      for (const k of ['other', 'team']) {
        const row = await rowOf(k);
        expect(row.g, k).not.toContain('delegation');
        expect(row.mc.delegate_to, k).toContain('appsmith');
        expect(row.mc.delegate_to, k).not.toContain('presenter');
        expect(row.mc.delegate_to, k).not.toContain('diagrammer');
      }
      expect((await rowOf('team')).mc.delegate_to).toEqual(['researcher', 'appsmith']);
      expect(await rec.reconcileWorkspaceDelegation(owner)).toEqual([]);
      expect((await rec.reconcileOwner(owner)).delegationChanges).toEqual([]);
      expect((await rowOf('team')).g).not.toContain('delegation');
    }, 240_000);

    it('a later assistant gets them once', async () => {
      await agent('later', { role: 'assistant', workspaceId: otherWs, groups: [] });
      expect(await rec.reconcileWorkspaceDelegation(owner)).toEqual([
        `${tag}-later:+delegation,diagrammer,presenter,appsmith`,
      ]);
      expect((await rowOf('later')).mc.delegate_to).toEqual(THREE);
      expect((await rowOf('later')).g).toEqual(['delegation']);
      expect(await rec.reconcileWorkspaceDelegation(owner)).toEqual([]);
    });

    it('drops the ids of deleted agents from the record', async () => {
      await agent('gone', { role: 'assistant', workspaceId: otherWs, groups: [] });
      await rec.reconcileWorkspaceDelegation(owner);
      expect(Object.keys(await granted())).toContain(ids.gone);
      await x(sql`delete from agents where id = ${ids.gone}`);
      await rec.reconcileWorkspaceDelegation(owner);
      expect(Object.keys(await granted())).not.toContain(ids.gone);
      expect(Object.keys(await granted())).toContain(ids.other);
    });
  },
);
