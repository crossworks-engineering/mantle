/**
 * The Recall serving tools against a real, migrated Postgres.
 *
 * The first test here is the one that matters: `recall_open` used to find a
 * map's entry card with `recall_nodes.id = recall_maps.id`, which was only
 * true of a page-built (v1) map, where the entry card WAS the root page. A native map's
 * entry card is an ordinary row with its own id, so every natively created map
 * answered "has no compiled index yet, its pages likely failed lint" — a lint
 * failure that never happened, about pages that do not exist. Nothing in the
 * old suite could catch it, because no native map existed to open.
 *
 * Also pinned: the score floor recall_match's description has always promised,
 * the publish gate, cross-map and former-slug resolution, the folder crumbs
 * the v2 catalog carries instead of an authored "start here" map, and (since
 * R5) that a leftover page-built row, one with no tree item, is never served.
 *
 * Seeds its own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/builtins-recall-serving.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** A unit vector in 768 dimensions, so cosine similarity is predictable:
 *  two axes are orthogonal (score 0) and a vector matches itself (score 1). */
function axis(i: number): string {
  const v = new Array(768).fill(0);
  v[i] = 1;
  return `[${v.join(',')}]`;
}

// The matcher embeds the caller's line. Fixed to one axis so the seeded
// prompts sit at a known distance from it: no embedder, no network, and the
// floor is exercised rather than approximated.
vi.mock('@mantle/embeddings', () => ({
  embed: vi.fn(async () => new Array(768).fill(0).map((_, i) => (i === 0 ? 1 : 0))),
}));

describe.skipIf(!URL)('Recall serving on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sqlTag: typeof import('drizzle-orm').sql;
  let open: BuiltinToolDef;
  let go: BuiltinToolDef;
  let index: BuiltinToolDef;
  let match: BuiltinToolDef;

  const owner = randomUUID();
  const ctx: ToolHandlerContext = { ownerId: owner, surface: { kind: 'web' } };
  // Not the brain's anchor row: `users_single_owner_idx` allows exactly one
  // is_owner, and a whole-suite run has other db tests seeding their own.
  // These four tools scope by owner_id and never ask whether it is the brain.
  const tag = `recall-serving-${owner.slice(0, 8)}`;

  // A native map: its id IS its node id, and its entry card has its own id.
  const native = { map: randomUUID(), entry: randomUUID(), card: randomUUID() };
  // A second native map, unsorted (filed at the Recall root).
  const status = { map: randomUUID(), entry: randomUUID() };
  // A leftover page-built (v1) row: no tree item, entry card sharing the map
  // id. Retired in R5; migration 0209 deletes these. Never served.
  const ghost = { map: randomUUID(), prompt: randomUUID() };
  // A native map an agent made that the owner has not published.
  const draft = { map: randomUUID(), entry: randomUUID() };
  // Folders: recall › Mantle › Fleet.
  const folders = { root: randomUUID(), mantle: randomUUID(), fleet: randomUUID() };

  const okOf = async (tool: BuiltinToolDef, input: Record<string, unknown>) => {
    const res = await tool.handler(input, ctx);
    return res as { ok: boolean; output?: Record<string, unknown>; error?: string };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    ({ sql: sqlTag } = await import('drizzle-orm'));
    const mod = await import('./builtins-recall');
    const byslug = (s: string) => mod.RECALL_TOOLS.find((t) => t.slug === s)!;
    open = byslug('recall_open');
    go = byslug('recall_go');
    index = byslug('recall_index');
    match = byslug('recall_match');

    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    // nodes.owner_id FKs to spaces: every node lives in one.
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);

    // The Recall root and two folders, as the item tree plants them.
    for (const [id, title, path] of [
      [folders.root, 'Recall', 'recall'],
      [folders.mantle, 'Mantle', 'recall.mantle'],
      [folders.fleet, 'Fleet', 'recall.mantle.fleet'],
    ] as const) {
      await m.db.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, slug, path)
        values (${id}, ${owner}, 'branch', ${title}, ${path.split('.').at(-1)}, ${path}::ltree)`);
    }
    // The native maps' items.
    for (const [id, title, path] of [
      [native.map, 'Fleet and access', 'recall.mantle.fleet'],
      [status.map, 'Status workflow', 'recall'],
      [draft.map, 'Agent draft', 'recall'],
    ] as const) {
      await m.db.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, slug, path)
        values (${id}, ${owner}, 'recall', ${title}, ${id}, ${path}::ltree)`);
    }

    // recall_maps. node_id set = native; null = a leftover page-built row.
    await m.db.execute(sqlTag`
      insert into recall_maps (id, owner_id, slug, title, enter_when, node_count, node_id,
                               published, version, former_slugs)
      values
        (${native.map}, ${owner}, 'fleet-and-access', 'Fleet and access',
         'Working on any box in the fleet', 2, ${native.map}, true, 1, '{"fleet-old"}'),
        (${status.map}, ${owner}, 'status-workflow', 'Status workflow',
         'Asking what we were busy with', 1, ${status.map}, true, 1, '{}'),
        (${ghost.map}, ${owner}, 'mantle-registry-start-here', 'Old registry',
         'Anything at all', 2, null, true, 0, '{}'),
        (${draft.map}, ${owner}, 'agent-draft', 'Agent draft',
         'Never, until published', 1, ${draft.map}, false, 1, '{}')`);

    // Cards. The native entry card carries its OWN id, which is the whole point.
    await m.db.execute(sqlTag`
      insert into recall_nodes (id, owner_id, map_id, slug, kind, title, body_md, use_when,
                                options, rank, prompt_pending)
      values
        (${native.entry}, ${owner}, ${native.map}, 'start', 'index', 'Fleet and access', '', '',
         ${JSON.stringify([
           { label: 'Box by box', useWhen: 'You need one box', targetSlug: 'box-by-box' },
           {
             label: 'The status workflow',
             useWhen: 'You want current work',
             targetSlug: 'status-workflow',
             targetMap: 'status-workflow',
           },
         ])}::jsonb, 0, false),
        (${native.card}, ${owner}, ${native.map}, 'box-by-box', 'knowledge', 'Box by box',
         'One line per box.', '', '[]'::jsonb, 1, false),
        (${status.entry}, ${owner}, ${status.map}, 'start', 'index', 'Status workflow',
         'Read the current work state.', '', '[]'::jsonb, 0, false),
        (${ghost.map}, ${owner}, ${ghost.map}, 'start', 'index', 'Old registry',
         'Stale text.', '', '[]'::jsonb, 0, false),
        (${draft.entry}, ${owner}, ${draft.map}, 'start', 'index', 'Agent draft', '', '',
         '[]'::jsonb, 0, false)`);

    // Two prompts: one on the query's axis (score 1), one orthogonal (score 0).
    await m.db.execute(sqlTag`
      insert into recall_nodes (id, owner_id, map_id, slug, kind, title, body_md, use_when,
                                options, embedding, rank, prompt_pending)
      values
        (${randomUUID()}, ${owner}, ${native.map}, 'the-close-prompt', 'prompt',
         'Close prompt', 'body', 'When the task is this one', '[]'::jsonb,
         ${axis(0)}::vector, 2, false),
        (${randomUUID()}, ${owner}, ${native.map}, 'the-far-prompt', 'prompt',
         'Far prompt', 'body', 'When the task is unrelated', '[]'::jsonb,
         ${axis(5)}::vector, 3, false),
        (${randomUUID()}, ${owner}, ${native.map}, 'the-pending-prompt', 'prompt',
         'Pending prompt', 'body', 'When the task is this one', '[]'::jsonb,
         ${axis(0)}::vector, 4, true),
        (${randomUUID()}, ${owner}, ${draft.map}, 'unpublished-prompt', 'prompt',
         'Unpublished prompt', 'body', 'When the task is this one', '[]'::jsonb,
         ${axis(0)}::vector, 1, false),
        (${ghost.prompt}, ${owner}, ${ghost.map}, 'ghost-prompt', 'prompt',
         'Ghost prompt', 'body', 'When the task is this one', '[]'::jsonb,
         ${axis(0)}::vector, 1, false)`);
  }, 60_000);

  afterAll(async () => {
    if (!URL) return;
    await m.db.execute(sqlTag`delete from recall_nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from recall_maps where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
  });

  it('opens a NATIVE map at its entry card (the v1 id assumption is gone)', async () => {
    const res = await okOf(open, { map: 'fleet-and-access' });
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(res.output).toMatchObject({ map: 'fleet-and-access', node: 'start', kind: 'index' });
    // And no stale note: a native map's rows ARE the source.
    expect(res.output?.note).toBeUndefined();
  });

  it('never serves a leftover page-built row: not listed, opened, followed or matched', async () => {
    const listed = await okOf(index, {});
    const slugs = (listed.output?.maps as { map: string }[]).map((x) => x.map);
    expect(slugs).not.toContain('mantle-registry-start-here');
    for (const ref of ['mantle-registry-start-here', ghost.map]) {
      const opened = await okOf(open, { map: ref });
      expect(opened.ok).toBe(false);
      expect(opened.error).toContain('No Recall map');
    }
    const went = await okOf(go, { map: 'mantle-registry-start-here', target: 'start' });
    expect(went.ok).toBe(false);
    // Nor as a cross-map target from a live map.
    const crossed = await okOf(go, {
      map: 'fleet-and-access',
      target: 'mantle-registry-start-here',
    });
    expect(crossed.ok).toBe(false);
    const matched = await okOf(match, { need: 'the task at hand' });
    const targets = (matched.output?.prompts as { target: string }[]).map((h) => h.target);
    expect(targets).not.toContain('ghost-prompt');
  });

  // Plan section 14: the old payloads are unchanged, and only the documented
  // additive fields differ (`folder` on a catalog entry, `map` on a cross-map
  // option, `version` on a native card, `use_when` on any card that has one).
  // Exact shapes, so a renamed or dropped key fails here rather than in every
  // agent that reads it.
  describe('golden payloads', () => {
    const iso = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/);

    it('recall_index: one entry per map', async () => {
      const res = await okOf(index, {});
      const maps = res.output!.maps as Record<string, unknown>[];
      expect(maps.find((x) => x.map === 'fleet-and-access')).toEqual({
        map: 'fleet-and-access',
        title: 'Fleet and access',
        enter_when: 'Working on any box in the fleet',
        nodes: 2,
        folder: 'Mantle / Fleet',
        updated_at: iso,
      });
      expect(Object.keys(res.output!).sort()).toEqual(['maps', 'note']);
    });

    it('recall_open: a native entry card', async () => {
      const res = await okOf(open, { map: 'fleet-and-access' });
      expect(res.output).toEqual({
        map: 'fleet-and-access',
        node: 'start',
        kind: 'index',
        title: 'Fleet and access',
        body_md: '',
        options: [
          { label: 'Box by box', use_when: 'You need one box', target: 'box-by-box' },
          {
            label: 'The status workflow',
            use_when: 'You want current work',
            target: 'status-workflow',
            map: 'status-workflow',
          },
        ],
        version: 1,
        updated_at: iso,
      });
    });

    it('recall_go: a knowledge card', async () => {
      const res = await okOf(go, { map: 'fleet-and-access', target: 'box-by-box' });
      expect(res.output).toEqual({
        map: 'fleet-and-access',
        node: 'box-by-box',
        kind: 'knowledge',
        title: 'Box by box',
        body_md: 'One line per box.',
        options: [],
        version: 1,
        updated_at: iso,
      });
    });

    it('recall_match: pointers only', async () => {
      const res = await okOf(match, { need: 'x' });
      const prompts = res.output!.prompts as Record<string, unknown>[];
      expect(prompts[0]).toEqual({
        map: 'fleet-and-access',
        target: 'the-close-prompt',
        title: 'Close prompt',
        use_when: 'When the task is this one',
        score: expect.any(Number),
      });
      expect(Object.keys(res.output!).sort()).toEqual(['note', 'prompts']);
    });
  });

  it('resolves a map by a slug it used to answer to', async () => {
    const res = await okOf(open, { map: 'fleet-old' });
    expect(res.ok).toBe(true);
    expect(res.output).toMatchObject({ map: 'fleet-and-access' });
  });

  it('hides an unpublished map from open, go and the catalog', async () => {
    const opened = await okOf(open, { map: 'agent-draft' });
    expect(opened.ok).toBe(false);
    expect(opened.error).toContain('No Recall map');
    const listed = await okOf(index, {});
    const slugs = (listed.output?.maps as { map: string }[]).map((x) => x.map);
    expect(slugs).not.toContain('agent-draft');
  });

  it('carries each map folder as crumbs, and orders folder then title', async () => {
    const res = await okOf(index, {});
    const maps = res.output?.maps as { map: string; folder: string | null }[];
    expect(maps.find((x) => x.map === 'fleet-and-access')?.folder).toBe('Mantle / Fleet');
    // Filed at the Recall root: unsorted, and unsorted sorts last.
    expect(maps.find((x) => x.map === 'status-workflow')?.folder).toBeNull();
    expect(maps.at(-1)?.map).toBe('status-workflow');
  });

  it('follows an option to a card, and a cross-map option to the other entry', async () => {
    const card = await okOf(go, { map: 'fleet-and-access', target: 'box-by-box' });
    expect(card.output).toMatchObject({ node: 'box-by-box', kind: 'knowledge' });

    // The option declares `map`, and plain recall_go(map, target) still lands:
    // the target resolves as another published map and serves ITS entry.
    const entry = await okOf(open, { map: 'fleet-and-access' });
    const opts = entry.output?.options as { target: string; map?: string }[];
    expect(opts.find((o) => o.target === 'status-workflow')?.map).toBe('status-workflow');
    const crossed = await okOf(go, { map: 'fleet-and-access', target: 'status-workflow' });
    expect(crossed.ok).toBe(true);
    expect(crossed.output).toMatchObject({ map: 'status-workflow', kind: 'index' });
  });

  it('drops a cross-map option to a map that is not published, and returns the version', async () => {
    await m.db.execute(sqlTag`
      update recall_nodes
         set options = options || ${JSON.stringify([
           {
             label: 'The draft',
             useWhen: 'never',
             targetSlug: 'agent-draft',
             targetMap: 'agent-draft',
           },
         ])}::jsonb
       where id = ${native.entry}`);
    try {
      const res = await okOf(open, { map: 'fleet-and-access' });
      const targets = (res.output!.options as { target: string }[]).map((o) => o.target);
      expect(targets).toContain('status-workflow');
      expect(targets).not.toContain('agent-draft');
      expect(res.output).toMatchObject({ version: 1 });
    } finally {
      await m.db.execute(sqlTag`
        update recall_nodes set options = options - 2 where id = ${native.entry}`);
    }
  });

  it('follows a cross-map option the natural way: recall_go(map: X, target: X)', async () => {
    const res = await okOf(go, { map: 'status-workflow', target: 'status-workflow' });
    expect(res.error).toBeUndefined();
    expect(res.output).toMatchObject({ map: 'status-workflow', node: 'start' });
    const native2 = await okOf(go, { map: 'fleet-and-access', target: 'fleet-and-access' });
    expect(native2.output).toMatchObject({ map: 'fleet-and-access', node: 'start', kind: 'index' });
  });

  it('applies the score floor, and skips pending and unpublished prompts', async () => {
    const res = await okOf(match, { need: 'the task at hand' });
    const hits = res.output?.prompts as { target: string; score: number }[];
    const targets = hits.map((h) => h.target);
    expect(targets).toContain('the-close-prompt');
    // Orthogonal: scores 0, and the floor is what keeps it out of an answer
    // the caller was told to trust.
    expect(targets).not.toContain('the-far-prompt');
    // An agent asked for prompt status; the owner has not confirmed it.
    expect(targets).not.toContain('the-pending-prompt');
    // Its map is unpublished.
    expect(targets).not.toContain('unpublished-prompt');
    expect(hits[0]?.score).toBeGreaterThan(0.9);
  });

  it('says no prompt fits, rather than handing back the best of a bad set', async () => {
    // Every prompt above the floor lives on axis 0; ask on an axis nothing
    // sits near and the honest answer is none.
    const { embed } = await import('@mantle/embeddings');
    vi.mocked(embed).mockResolvedValueOnce(
      new Array(768).fill(0).map((_, i) => (i === 300 ? 1 : 0)),
    );
    const res = await okOf(match, { need: 'something nothing covers' });
    expect(res.ok).toBe(true);
    expect(res.output?.prompts).toEqual([]);
    expect(String(res.output?.note)).toContain('Proceed without one');
  });
});
