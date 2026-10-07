/**
 * The embed edges the database keeps (migration 0208) read the stored data
 * the way the TypeScript walkers do: mantle_page_embed_refs is
 * referencedEmbedIds, mantle_draw_embed_refs is drawPlacedFileIds, and
 * mantle_note_embed_refs is noteEmbedIds, except that a note's image counts
 * wherever the note shows it (a heading, a table cell), a little more than
 * noteEmbedIds lists. Each reference also names the kind it may open (an
 * image a file, a drawing image a drawing, a child page card a page), and
 * no stored shape, however malformed, makes them throw. Pinned here so the
 * two cannot drift.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/embed-edges.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { drawPlacedFileIds, noteEmbedIds } from './embed-closure';
import { referencedEmbedIds } from './doc-assets';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('embed edges in SQL match the TypeScript walkers', () => {
  let m: typeof import('@mantle/db');
  let sqlTag: typeof import('drizzle-orm').sql;
  const id = () => randomUUID();
  const sortLower = (ids: readonly string[]) => [...ids].map((i) => i.toLowerCase()).sort();

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
  }, 60_000);

  /** The 'kind:uuid' references a parser finds. */
  const sqlRefs = async (fn: 'page' | 'draw' | 'note', arg: unknown): Promise<string[]> => {
    const call =
      fn === 'note'
        ? sqlTag`mantle_note_embed_refs(${arg as string})`
        : fn === 'page'
          ? sqlTag`mantle_page_embed_refs(${JSON.stringify(arg)}::jsonb)`
          : sqlTag`mantle_draw_embed_refs(${JSON.stringify((arg as { scene?: unknown })?.scene ?? null)}::jsonb, ${JSON.stringify((arg as { refs?: unknown })?.refs ?? null)}::jsonb)`;
    const [row] = (await m.db.execute(sqlTag`select ${call} as refs`)) as unknown as Array<{
      refs: string[];
    }>;
    return [...row!.refs].sort();
  };
  const sqlIds = async (fn: 'page' | 'draw' | 'note', arg: unknown): Promise<string[]> =>
    sortLower((await sqlRefs(fn, arg)).map((r) => r.split(':')[1]!));

  it('pages: images, page images, file embeds, drawings and child pages; not links', async () => {
    const [a, b, c, d, e, link] = [id(), id(), id(), id(), id(), id()];
    const doc = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { nodeId: a } },
        { type: 'pageImage', attrs: { drawId: b } },
        { type: 'fileEmbed', attrs: { nodeId: c } },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'childPage', attrs: { pageId: d } }],
            },
          ],
        },
        { type: 'image', attrs: { drawId: e, nodeId: 'not-an-id' } },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: link } }] },
            { type: 'mention', attrs: { id: link } },
          ],
        },
      ],
    };
    const ts = sortLower(referencedEmbedIds(doc).filter((x) => x !== 'not-an-id'));
    expect(await sqlIds('page', doc)).toEqual(ts);
    expect(ts).toHaveLength(5);
    // Each names the kind it may open.
    expect(await sqlRefs('page', doc)).toEqual(
      [`file:${a}`, `draw:${b}`, `file:${c}`, `page:${d}`, `draw:${e}`].sort(),
    );
    expect(await sqlIds('page', null)).toEqual([]);
    expect(await sqlIds('page', { type: 'doc' })).toEqual([]);
  });

  it('drawings: the files the published scene places, not the whole map', async () => {
    const [a, b, c] = [id(), id(), id()];
    const refs = { x: a, y: b, z: c, n: 3 };
    const scene = {
      elements: [
        { type: 'image', fileId: 'x' },
        { type: 'image', fileId: 'y', isDeleted: true },
        { type: 'rectangle', fileId: 'z' },
        { type: 'image', fileId: 'n' },
        { type: 'image', fileId: 'missing' },
      ],
    };
    expect(await sqlIds('draw', { scene, refs })).toEqual(
      sortLower(drawPlacedFileIds(scene, refs)),
    );
    expect(await sqlIds('draw', { scene, refs })).toEqual([a.toLowerCase()]);
    expect(await sqlIds('draw', { scene: null, refs })).toEqual([]);
  });

  it('notes: images and lone file links, never code or inline links', async () => {
    const [img, drw, file, inFence, inCode, inline, tilde] = [
      id(),
      id(),
      id(),
      id(),
      id(),
      id(),
      id(),
    ];
    const md = [
      `Intro ![pic](media:${img}) mid-sentence.`,
      '',
      `![d](draw:${drw})`,
      '',
      `[report](media:${file})`,
      '',
      '```',
      `![no](media:${inFence})`,
      '```',
      '',
      `Some \`![no](media:${inCode})\` code.`,
      '',
      `A line with [a link](media:${inline}) inside.`,
      '',
      '~~~md',
      `![no](media:${tilde})`,
      '~~~',
    ].join('\n');
    expect(await sqlIds('note', md)).toEqual(sortLower(noteEmbedIds(md)));
    expect(await sqlIds('note', md)).toEqual(sortLower([img, drw, file]));
    expect(await sqlRefs('note', md)).toEqual(
      [`file:${img}`, `draw:${drw}`, `file:${file}`].sort(),
    );
    expect(await sqlIds('note', '')).toEqual([]);
  });

  it('notes: an image in a heading or a table counts (the note shows it)', async () => {
    const [h, t] = [id(), id()];
    const md = `# Title ![h](media:${h})\n\n| a |\n|---|\n| ![t](media:${t}) |`;
    const fromSql = await sqlIds('note', md);
    // A superset of noteEmbedIds: whatever it finds, SQL finds too.
    for (const x of noteEmbedIds(md)) expect(fromSql).toContain(x.toLowerCase());
    expect(fromSql).toEqual(sortLower([h, t]));
  });

  it('never throws on a malformed stored shape', async () => {
    const x = id();
    for (const doc of [
      null,
      [],
      'text',
      42,
      { content: 'not an array' },
      { content: [1, 'a', null, [], { type: 'image', attrs: 'str' }] },
      { content: [{ type: 'image', attrs: { nodeId: 5, drawId: { a: 1 } } }] },
      { content: [{ type: 7, attrs: { nodeId: x } }] },
      { type: 'childPage', attrs: [x] },
    ]) {
      await expect(sqlIds('page', doc)).resolves.toEqual([]);
    }
    const placing = { elements: [{ type: 'image', fileId: 'a' }] };
    for (const refs of [null, [], 'x', 3, { a: { b: x } }, { a: 7 }, { a: [x] }]) {
      await expect(sqlIds('draw', { scene: placing, refs })).resolves.toEqual([]);
    }
    for (const scene of [
      null,
      [],
      'x',
      { elements: 'x' },
      { elements: [1, null, { fileId: 7 }] },
    ]) {
      await expect(sqlIds('draw', { scene, refs: { a: x } })).resolves.toEqual([]);
    }
    for (const md of ['```', '```\n![a](media:' + x + ')', '~~~~\n~~~', '`', '![](media:)']) {
      await expect(sqlIds('note', md)).resolves.toEqual([]);
    }
    // A note whose data is not an object, or whose content is not text,
    // goes through the same statements the backfill and the sweep run.
    const [row] = (await m.db.execute(sqlTag`
      select count(*)::int as n from (values ('[1,2]'::jsonb), ('{"content": 5}'::jsonb),
                                             ('{"content": {"a": 1}}'::jsonb), ('"s"'::jsonb)) v(data)
       cross join lateral unnest(mantle_note_embed_refs(v.data->>'content')) t
       where jsonb_typeof(v.data) = 'object' and v.data ? 'content'`)) as unknown as Array<{
      n: number;
    }>;
    expect(row!.n).toBe(0);
  });
});
