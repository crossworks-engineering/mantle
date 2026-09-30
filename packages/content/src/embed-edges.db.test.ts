/**
 * The embed edges the database keeps (migration 0208) read the stored data
 * the way the TypeScript walkers do: mantle_page_embed_ids is
 * referencedEmbedIds, mantle_draw_embed_ids is drawEmbedIds, and
 * mantle_note_embed_ids is noteEmbedIds, except that a note's image counts
 * wherever the note shows it (a heading, a table cell), a little more than
 * noteEmbedIds lists. Pinned here so the two cannot drift.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/embed-edges.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { drawEmbedIds, noteEmbedIds } from './embed-closure';
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
  });

  const sqlIds = async (fn: 'page' | 'draw' | 'note', arg: unknown): Promise<string[]> => {
    const call =
      fn === 'note'
        ? sqlTag`mantle_note_embed_ids(${arg as string})`
        : fn === 'page'
          ? sqlTag`mantle_page_embed_ids(${JSON.stringify(arg)}::jsonb)`
          : sqlTag`mantle_draw_embed_ids(${JSON.stringify(arg)}::jsonb)`;
    const [row] = (await m.db.execute(sqlTag`select ${call}::text[] as ids`)) as unknown as Array<{
      ids: string[];
    }>;
    return sortLower(row!.ids);
  };

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
    expect(await sqlIds('page', null)).toEqual([]);
    expect(await sqlIds('page', { type: 'doc' })).toEqual([]);
  });

  it('drawings: every file in the map', async () => {
    const [a, b] = [id(), id()];
    const refs = { x: a, y: b, z: a, n: 3 };
    expect(await sqlIds('draw', refs)).toEqual(sortLower(drawEmbedIds(refs)));
    expect(await sqlIds('draw', [])).toEqual([]);
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
});
