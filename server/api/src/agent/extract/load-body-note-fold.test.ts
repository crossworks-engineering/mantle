/**
 * Always fold for notes (workspaces plan 5.3, W2): a note's indexed body
 * holds its own words and a marker per embedded file or drawing, never the
 * embed's caption. The note's markdown itself is unchanged.
 */
import { describe, expect, it, vi } from 'vitest';

const rows = vi.hoisted(() => ({ next: [] as unknown[] }));
vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => rows.next,
  };
  return { ...actual, db: { ...actual.db, select: vi.fn(() => chain), update: vi.fn() } };
});
vi.mock('@mantle/tracing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/tracing')>();
  return {
    ...actual,
    recordSkippedTrace: vi.fn(),
    step: vi.fn(async (_spec: unknown, fn: (handle: unknown) => unknown) =>
      fn({ ok: vi.fn(), fail: vi.fn() }),
    ),
  };
});

import { readNodeBodyLocal } from './load-body';

describe('a note body indexes markers for its embeds', () => {
  it('keeps its own words and links, never an embed caption', async () => {
    const content =
      'Valve notes.\n![zanzibar gauge](media:abc)\n[quokka quote](media:def)\n![okapi](draw:ghi)\nSee [docs](https://example.invalid).';
    const body = await readNodeBodyLocal({
      id: 'n1',
      ownerId: 'o1',
      type: 'note',
      title: 'Valve',
      tags: [],
      data: { content },
    } as never);
    expect(body).toContain('Valve notes.');
    expect(body).toContain('[embedded file]');
    expect(body).toContain('[embedded drawing]');
    expect(body).toContain('[docs](https://example.invalid)');
    for (const w of ['zanzibar', 'quokka', 'okapi']) expect(body).not.toContain(w);
  });
});

describe('a page or drawing body is computed from its source, never the stored text', () => {
  // A row saved before always fold may still hold an embed's words in
  // doc_text or scene_text until the re-fold runs (W2 audit, HIGH): the
  // extractor must not summarise those words as the item's own.
  it('a page: markers from pages.doc, whatever doc_text holds', async () => {
    rows.next = [
      {
        doc: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Pump overhaul notes.' }] },
            { type: 'image', attrs: { nodeId: 'f1', alt: 'zanzibar.png', src: null } },
          ],
        },
        docText: 'Pump overhaul notes.\n[Embedded file: zanzibar.png]\nquokka calibration',
      },
    ];
    const body = await readNodeBodyLocal({
      id: 'p1',
      ownerId: 'o1',
      type: 'page',
      title: 'Pump',
      tags: [],
      data: {},
      audience: 'admin',
      inheritedLevel: null,
      embeddedLevel: null,
    } as never);
    expect(body).toContain('Pump overhaul notes.');
    expect(body).toContain('[embedded file]');
    for (const w of ['zanzibar', 'quokka']) expect(body).not.toContain(w);
  });

  it('a drawing: labels and a marker per placed image from draws.scene', async () => {
    rows.next = [
      {
        scene: {
          elements: [
            { type: 'text', text: 'Valve train', id: 't1' },
            { type: 'image', fileId: 'x1', id: 'i1' },
          ],
        },
        fileRefs: { x1: 'file-node-1' },
        sceneText: 'Valve train\nokapi gauge reading',
      },
    ];
    const body = await readNodeBodyLocal({
      id: 'd1',
      ownerId: 'o1',
      type: 'draw',
      title: 'Valves',
      tags: [],
      data: {},
    } as never);
    expect(body).toContain('Valve train');
    expect(body).toContain('[embedded file]');
    expect(body).not.toContain('okapi');
  });
});
