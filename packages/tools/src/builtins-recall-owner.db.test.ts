/**
 * The owner's Recall acts over MCP (builtins-recall-owner.ts), driven the way
 * an MCP client drives them, against a real migrated Postgres.
 *
 * What is pinned: each act works as the OWNER (the revision log says so), is
 * tied to the version the user was shown, and refuses anyone who is not the
 * owner. `recall_map_delete` is exercised on both arms, as the destructive
 * sweep requires.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/builtins-recall-owner.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the Recall owner tools over MCP, on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sqlTag: typeof import('drizzle-orm').sql;
  let tool: (slug: string) => BuiltinToolDef;

  const owner = randomUUID();
  const tag = `recall-owner-${owner.slice(0, 8)}`;
  // An MCP client: the owner's token, on the owner's MCP surface.
  const mcp = { ownerId: owner, surface: { kind: 'owner', via: 'mcp' } } as ToolHandlerContext;
  // An in-app agent, which makes the drafts and requests the owner acts on.
  const agent = {
    ownerId: owner,
    surface: { kind: 'web' },
    agent: { slug: 'librarian', depth: 1, delegateTo: [] },
  } as unknown as ToolHandlerContext;

  type Res = { ok: boolean; output?: Record<string, unknown>; error?: string };
  const call = async (slug: string, input: Record<string, unknown>, ctx = mcp) =>
    (await tool(slug).handler(input, ctx)) as Res;
  const versionOf = async (map: string) =>
    Number((await call('recall_map_get', { map })).output!.version);
  const revisionsOf = async (map: string) =>
    (await call('recall_revisions', { map })).output!.revisions as {
      id: string;
      summary: string;
      actor: string;
      card: string | null;
    }[];

  /** A draft map an agent made, with one card it asked to make a prompt. */
  const draftWithRequest = async (title: string) => {
    const made = await call(
      'recall_map_create',
      { title, enter_when: `working on ${title}` },
      agent,
    );
    const map = String(made.output!.map);
    await call(
      'recall_card_put',
      { map, title: 'Deploy', body: 'do x', use_when: 'deploying', prompt: true },
      agent,
    );
    return map;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    ({ sql: sqlTag } = await import('drizzle-orm'));
    const all = [
      ...(await import('./builtins-recall')).RECALL_TOOLS,
      ...(await import('./builtins-recall-write')).RECALL_WRITE_TOOLS,
      ...(await import('./builtins-recall-owner')).RECALL_OWNER_TOOLS,
    ];
    tool = (slug) => all.find((t) => t.slug === slug)!;
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
  });

  afterAll(async () => {
    if (!URL) return;
    await m.db.execute(sqlTag`delete from recall_revisions where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from recall_nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from recall_maps where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
  });

  it('recall_pending shows the drafts and the prompt requests, with the text and version', async () => {
    const map = await draftWithRequest('Waiting');
    const res = await call('recall_pending', {});
    const drafts = res.output!.unpublished_maps as { map: string; version: number }[];
    const asks = res.output!.prompt_requests as Record<string, unknown>[];
    expect(drafts.map((d) => d.map)).toContain(map);
    expect(asks.find((a) => a.map === map)).toMatchObject({
      card: 'deploy',
      use_when: 'deploying',
      body_md: 'do x',
      version: await versionOf(map),
    });
  });

  it('recall_map_get reads an unpublished map whole, which recall_open cannot', async () => {
    const map = await draftWithRequest('Unseen');
    expect((await call('recall_open', { map })).ok).toBe(false);
    const got = await call('recall_map_get', { map });
    expect(got.output).toMatchObject({ map, published: false });
    const cards = got.output!.cards as Record<string, unknown>[];
    expect(cards.find((c) => c.card === 'deploy')).toMatchObject({
      prompt_pending: true,
      body_md: 'do x',
    });
  });

  it('recall_prompt_confirm confirms as the owner, tied to the version shown', async () => {
    const map = await draftWithRequest('Confirming');
    const shown = await versionOf(map);
    const blind = await call('recall_prompt_confirm', { map, card: 'deploy', confirm: true });
    expect(blind.ok).toBe(false);
    // The agent changes the text after the user was shown it.
    await call(
      'recall_card_put',
      { map, card: 'deploy', title: 'Deploy', body: 'do y', version: shown },
      agent,
    );
    const stale = await call('recall_prompt_confirm', {
      map,
      card: 'deploy',
      confirm: true,
      version: shown,
    });
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/changed since you read it/);

    const ok = await call('recall_prompt_confirm', {
      map,
      card: 'deploy',
      confirm: true,
      version: await versionOf(map),
    });
    expect(ok.ok).toBe(true);
    const rows = (await m.db.execute(sqlTag`
      select n.kind, n.prompt_pending from recall_nodes n
        join recall_maps r on r.id = n.map_id
       where r.owner_id = ${owner} and r.slug = ${map} and n.slug = 'deploy'`)) as unknown as {
      kind: string;
      prompt_pending: boolean;
    }[];
    expect(rows[0]).toMatchObject({ kind: 'prompt', prompt_pending: false });
    expect((await revisionsOf(map))[0]).toMatchObject({
      summary: 'prompt confirmed',
      actor: 'owner (mcp)',
    });
  });

  it('recall_map_publish makes a draft visible to agents', async () => {
    const map = await draftWithRequest('Publishing');
    const res = await call('recall_map_publish', {
      map,
      published: true,
      version: await versionOf(map),
    });
    expect(res.ok).toBe(true);
    const listed = await call('recall_index', {});
    expect((listed.output!.maps as { map: string }[]).map((x) => x.map)).toContain(map);
  });

  describe('recall_map_delete', () => {
    it('without confirm: true only says what would go', async () => {
      const map = await draftWithRequest('Kept');
      const res = await call('recall_map_delete', { map });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/Tell the user.*confirm: true/s);
      expect((await call('recall_map_get', { map })).ok).toBe(true);
    });

    it('with confirm: true deletes the map, its cards and its log', async () => {
      const map = await draftWithRequest('Gone');
      const res = await call('recall_map_delete', { map, confirm: true });
      expect(res.output).toMatchObject({ map, deleted: true });
      expect((await call('recall_map_get', { map })).ok).toBe(false);
    });
  });

  it('recall_cards_reorder, recall_revisions and recall_revision_restore', async () => {
    const map = await draftWithRequest('Ordered');
    await call('recall_card_put', { map, title: 'Second', body: '' }, agent);
    const order = await call('recall_cards_reorder', {
      map,
      slugs: ['second', 'deploy'],
      version: await versionOf(map),
    });
    expect(order.ok).toBe(true);
    const cards = () =>
      call('recall_map_get', { map }).then((r) =>
        (r.output!.cards as { card: string }[]).map((c) => c.card),
      );
    expect(await cards()).toEqual(['start', 'second', 'deploy']);
    const reordered = (await revisionsOf(map)).find((r) => r.summary === 'cards reordered')!;
    const undo = await call('recall_revision_restore', { revision_id: reordered.id });
    expect(undo.ok).toBe(true);
    expect(await cards()).toEqual(['start', 'deploy', 'second']);
  });

  it('recall_map_set_slug and recall_card_set_slug keep the old slugs resolving', async () => {
    const map = await draftWithRequest('Slugged');
    const moved = await call('recall_map_set_slug', {
      map,
      slug: 'slugged-now',
      version: await versionOf(map),
    });
    expect(moved.output).toMatchObject({ map: 'slugged-now', former: map });
    const card = await call('recall_card_set_slug', {
      map, // the old slug still finds the map
      card: 'deploy',
      slug: 'deploy-steps',
      version: await versionOf('slugged-now'),
    });
    expect(card.output).toMatchObject({ card: 'deploy-steps', former: 'deploy' });
    const got = await call('recall_map_get', { map: 'slugged-now' });
    // The card kept its text and its pending request.
    expect(
      (got.output!.cards as Record<string, unknown>[]).find((c) => c.card === 'deploy-steps'),
    ).toMatchObject({ body_md: 'do x', prompt_pending: true });
  });

  it('refuses anyone who is not the owner, reads included', async () => {
    const map = await draftWithRequest('Private');
    for (const surface of [{ kind: 'team' }, { kind: 'client', loginId: owner }, undefined]) {
      const other = { ownerId: owner, surface } as unknown as ToolHandlerContext;
      expect(await call('recall_pending', {}, other)).toMatchObject({ ok: false });
      expect(
        await call('recall_map_publish', { map, published: true, version: 1 }, other),
      ).toMatchObject({ ok: false });
    }
  });
});
