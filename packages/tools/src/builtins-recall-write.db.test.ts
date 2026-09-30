/**
 * The Recall v2 write TOOLS, driven as an agent drives them, against a real
 * migrated Postgres.
 *
 * The write module has its own tests (packages/content/src/recall-native.db.
 * test.ts); what is checked here is the agent-facing contract on top of it:
 * that an edit serves immediately, that the three owner-only acts are refused
 * with something an agent can act on, and that a refusal comes back as a
 * failed tool result rather than a thrown error the loop cannot read.
 *
 * `recall_card_delete` is exercised on both arms deliberately: it is a
 * destructive tool, and destructive-coverage.test.ts requires that.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/builtins-recall-write.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the Recall write tools, on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sqlTag: typeof import('drizzle-orm').sql;
  let create: BuiltinToolDef;
  let put: BuiltinToolDef;
  let del: BuiltinToolDef;
  let update: BuiltinToolDef;
  let go: BuiltinToolDef;
  let index: BuiltinToolDef;

  const owner = randomUUID();
  const tag = `recall-write-${owner.slice(0, 8)}`;
  // An agent turn: ctx.agent is what the revision log attributes the write to.
  const ctx: ToolHandlerContext = {
    ownerId: owner,
    surface: { kind: 'web' },
    agent: { slug: 'librarian', depth: 1, delegateTo: [] },
  } as unknown as ToolHandlerContext;

  const call = async (tool: BuiltinToolDef, input: Record<string, unknown>) =>
    (await tool.handler(input, ctx)) as {
      ok: boolean;
      output?: Record<string, unknown>;
      error?: string;
    };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    ({ sql: sqlTag } = await import('drizzle-orm'));
    const read = await import('./builtins-recall');
    const write = await import('./builtins-recall-write');
    const bySlug = (s: string) =>
      [...read.RECALL_TOOLS, ...write.RECALL_WRITE_TOOLS].find((t) => t.slug === s)!;
    create = bySlug('recall_map_create');
    put = bySlug('recall_card_put');
    del = bySlug('recall_card_delete');
    update = bySlug('recall_map_update');
    go = bySlug('recall_go');
    index = bySlug('recall_index');

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

  /** A published map, the state an agent normally finds. */
  const publishedMap = async (title: string) => {
    const made = await call(create, { title, enter_when: `Working on ${title}` });
    const slug = String(made.output!.map);
    await m.db.execute(sqlTag`update recall_maps set published = true where slug = ${slug}`);
    return slug;
  };

  it('creates a map UNPUBLISHED, and says so rather than looking done', async () => {
    const res = await call(create, { title: 'Agent map', enter_when: 'Some time' });
    expect(res.ok).toBe(true);
    expect(res.output).toMatchObject({ published: false });
    expect(String(res.output!.note)).toMatch(/unpublished.*ask the owner to publish/is);
    // And it really is invisible to the agent-facing catalog.
    const listed = await call(index, {});
    const slugs = (listed.output?.maps as { map: string }[] | undefined) ?? [];
    expect(slugs.map((x) => x.map)).not.toContain(res.output!.map);
  });

  it('writes a card that serves immediately', async () => {
    const map = await publishedMap('Immediate');
    const res = await call(put, {
      map,
      title: 'Box by box',
      body: 'One line per box.',
    });
    expect(res.ok).toBe(true);
    // No compile step, no publish step: the next read sees it.
    const read = await call(go, { map, target: 'box-by-box' });
    expect(read.ok).toBe(true);
    expect(read.output).toMatchObject({ node: 'box-by-box', body_md: 'One line per box.' });
  });

  it('hands back the warnings without failing the write', async () => {
    const map = await publishedMap('Warned');
    const res = await call(put, { map, title: 'Unreachable', body: 'x' });
    expect(res.ok).toBe(true);
    expect((res.output!.warnings as string[]).join(' ')).toMatch(/No option leads to/i);
  });

  it('records a prompt request without minting a prompt', async () => {
    const map = await publishedMap('Requested');
    const res = await call(put, {
      map,
      title: 'The procedure',
      body: 'steps',
      use_when: 'doing the thing',
      prompt: true,
    });
    expect(res.output).toMatchObject({ prompt_pending: true });
    expect(String(res.output!.note)).toMatch(/owner confirms/i);
    const rows = (await m.db.execute(sqlTag`
      select kind, prompt_pending from recall_nodes
       where owner_id = ${owner} and slug = 'the-procedure'`)) as unknown as {
      kind: string;
      prompt_pending: boolean;
    }[];
    expect(rows[0]).toMatchObject({ kind: 'knowledge', prompt_pending: true });
  });

  it('refuses a body over budget, and the error says to split the card', async () => {
    const map = await publishedMap('Budgeted');
    const res = await call(put, { map, title: 'Long', body: 'x'.repeat(6001) });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/[Ss]plit it/);
  });

  it('names recall_index when the map is not there', async () => {
    const res = await call(put, { map: 'no-such-map', title: 'X', body: 'y' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/recall_index lists the maps/);
  });

  // ── recall_card_delete: both arms ─────────────────────────────────────────

  describe('recall_card_delete (one card, never the whole map)', () => {
    it('deletes a card and reports the options it had to remove', async () => {
      const map = await publishedMap('Deleting');
      await call(put, { map, title: 'Detail', body: 'detail' });
      await call(put, {
        map,
        card: 'start',
        title: 'Deleting',
        body: '',
        options: [{ label: 'The detail', use_when: 'you need it', target: 'detail' }],
      });
      const res = await call(del, { map, card: 'detail' });
      expect(res.ok).toBe(true);
      expect(res.output!.options_removed).toEqual(["start: 'The detail'"]);
      const gone = await call(go, { map, target: 'detail' });
      expect(gone.ok).toBe(false);
    });

    it('refuses to delete the entry card, and says to delete the map instead', async () => {
      const map = await publishedMap('Protected');
      const res = await call(del, { map, card: 'start' });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/entry card.*delete the map instead/s);
    });
  });

  // ── the owner-only acts ───────────────────────────────────────────────────

  it('renames a map without moving its slug', async () => {
    const map = await publishedMap('Original name');
    const res = await call(update, { map, title: 'Quite different' });
    expect(res.ok).toBe(true);
    const rows = (await m.db.execute(sqlTag`
      select slug, title from recall_maps where id::text in (
        select id::text from recall_maps where owner_id = ${owner} and slug = ${map})`)) as unknown as {
      slug: string;
      title: string;
    }[];
    // The slug is what agents and skills remember, so a rename leaves it.
    expect(rows[0]).toMatchObject({ slug: map, title: 'Quite different' });
  });

  it('offers an agent no way to publish, confirm a prompt, or delete a map', async () => {
    const write = await import('./builtins-recall-write');
    const slugs = write.RECALL_WRITE_TOOLS.map((t) => t.slug);
    expect(slugs).toEqual([
      'recall_map_create',
      'recall_card_put',
      'recall_card_delete',
      'recall_map_update',
    ]);
    // The shape of the gate: no input on any of these can publish a map or
    // confirm a prompt. `prompt` only ever records a request.
    const props = Object.keys(
      (update.inputSchema as { properties: Record<string, unknown> }).properties,
    );
    expect(props).not.toContain('published');
    expect(props).not.toContain('slug');
  });
});
