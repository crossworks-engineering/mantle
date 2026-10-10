/**
 * Always fold for notes (workspaces plan 5.3, W2): a note's indexed body
 * holds its own words and a marker per embedded file or drawing, never the
 * embed's caption. The note's markdown itself is unchanged.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  return { ...actual, db: { ...actual.db, select: vi.fn(), update: vi.fn() } };
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
