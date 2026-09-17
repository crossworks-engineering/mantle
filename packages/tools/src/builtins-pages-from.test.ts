/**
 * Behavioural tests for the server-side import tools: page_from_note,
 * page_from_notes, page_from_journal, page_from_file and
 * page_replace_from_file.
 *
 * What these have in common is that the body never round-trips through the
 * model: it is read from the source node and handed to markdownToDoc
 * directly. So the thing to pin is the STRING that reaches markdownToDoc
 * (section headings, order, raw concatenation) and the lineage edge that
 * follows (supersedeNode on the source, or deliberately not, for journal
 * entries). markdownToDoc is stubbed with a spy for that reason: asserting
 * the exact markdown is more precise than asserting the shape of a parsed
 * doc.
 *
 * Two contracts are worth pinning on their own:
 *
 *  - Supersede is BEST-EFFORT. A failed lineage stamp must not fail the
 *    import (the page exists; the mark is recoverable via content_supersede),
 *    but the output must say the stamp did not land.
 *  - page_replace_from_file is the one import that writes to a DRAFT, and it
 *    does so UNCONDITIONALLY (no baseRev): the body is built wholesale from
 *    the file, so there is no read-modify-write race to protect. Metadata
 *    goes to the published row via updatePage and never carries a doc.
 *
 * Store edges are stubbed; the tools' own guards, title derivation and
 * concatenation are real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...actual,
    createPage: vi.fn(),
    updatePage: vi.fn(),
    getPage: vi.fn(),
    saveDraft: vi.fn(),
    getNote: vi.fn(),
    getJournal: vi.fn(),
    supersedeNode: vi.fn(),
    markdownToDoc: vi.fn((md: string) => ({ type: 'doc', content: [{ type: 'paragraph', md }] })),
    nodeUrl: (id: string) => `https://brain.test/n/${id}`,
  };
});
vi.mock('@mantle/files', () => ({ fileById: vi.fn(), readFileById: vi.fn() }));
vi.mock('@mantle/tracing', () => ({ recordIngest: vi.fn() }));

import {
  createPage,
  updatePage,
  getPage,
  saveDraft,
  getNote,
  getJournal,
  supersedeNode,
  markdownToDoc,
} from '@mantle/content';
import { fileById, readFileById } from '@mantle/files';
import { recordIngest } from '@mantle/tracing';
import { PAGE_TOOLS } from './builtins-pages';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const all = PAGE_TOOLS as readonly BuiltinToolDef[];
const fromNote = all.find((t) => t.slug === 'page_from_note')!;
const fromNotes = all.find((t) => t.slug === 'page_from_notes')!;
const fromJournal = all.find((t) => t.slug === 'page_from_journal')!;
const fromFile = all.find((t) => t.slug === 'page_from_file')!;
const replaceFromFile = all.find((t) => t.slug === 'page_replace_from_file')!;

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const PAGE_ID = 'p-new';
const FILE_ID = 'f-1';

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

/** The markdown string handed to the parser on the most recent call. */
function parsedMarkdown(): string {
  const call = vi.mocked(markdownToDoc).mock.calls.at(-1);
  if (!call) throw new Error('markdownToDoc was not called');
  return call[0];
}

const note = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Note ${id}`,
  content: `body of ${id}`,
  tags: [`t-${id}`],
  summary: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

const entry = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Entry ${id}`,
  body: `journal ${id}`,
  entryDate: '2026-09-01',
  tags: [`j-${id}`],
  createdAt: '2026-09-02T10:00:00.000Z',
  ...over,
});

const fileMeta = (over: Record<string, unknown> = {}) => ({
  id: FILE_ID,
  filename: 'launch-plan.md',
  mimeType: 'text/markdown',
  isText: true,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createPage).mockResolvedValue({
    id: PAGE_ID,
    title: 'Created',
    tags: ['x'],
  } as never);
  vi.mocked(updatePage).mockResolvedValue({ id: 'p-1', title: 'Runbook', tags: [] } as never);
  vi.mocked(getPage).mockResolvedValue({ id: 'p-1', doc: {}, draft: null } as never);
  vi.mocked(saveDraft).mockResolvedValue({ ok: true, rev: 2 } as never);
  vi.mocked(getNote).mockImplementation(async (_owner, id) => note(id) as never);
  vi.mocked(getJournal).mockImplementation(async (_owner, id) => entry(id) as never);
  vi.mocked(supersedeNode).mockResolvedValue({} as never);
  vi.mocked(fileById).mockResolvedValue(fileMeta() as never);
  vi.mocked(readFileById).mockResolvedValue({
    row: fileMeta(),
    bytes: Buffer.from('# Launch\n\nGo.'),
    path: '/x',
  } as never);
});

describe('page_from_note', () => {
  it('refuses a blank note id without reading anything', async () => {
    expect(errorOf(await fromNote.handler({ note_id: ' ' }, ctx))).toMatch(/note_id is required/);
    expect(getNote).not.toHaveBeenCalled();
    expect(createPage).not.toHaveBeenCalled();
  });

  it('reports a missing note with the lookup that fixes it, creating nothing', async () => {
    vi.mocked(getNote).mockResolvedValue(null as never);
    expect(errorOf(await fromNote.handler({ note_id: 'n-1' }, ctx))).toMatch(/note_list/);
    expect(getNote).toHaveBeenCalledWith('o1', 'n-1');
    expect(createPage).not.toHaveBeenCalled();
  });

  it("copies the note's body server-side and borrows its title and tags", async () => {
    const res = await fromNote.handler({ note_id: 'n-1' }, ctx);
    expect(parsedMarkdown()).toBe('body of n-1');
    expect(createPage).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({ title: 'Note n-1', tags: ['t-n-1'] }),
    );
    expect(vi.mocked(createPage).mock.calls[0]![1]).not.toHaveProperty('parentId');
    expect(outputOf(res)).toMatchObject({ id: PAGE_ID, source_note_id: 'n-1' });
    expect(recordIngest).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent_tool', ownerId: 'o1', nodeId: PAGE_ID }),
    );
  });

  it('lets explicit title, tags and parent override the defaults', async () => {
    await fromNote.handler(
      { note_id: 'n-1', title: 'Better', tags: ['mine'], parent_id: 'p-parent' },
      ctx,
    );
    expect(createPage).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({ title: 'Better', tags: ['mine'], parentId: 'p-parent' }),
    );
  });

  it('marks the note superseded by the new page, owner-scoped', async () => {
    const res = await fromNote.handler({ note_id: 'n-1' }, ctx);
    expect(supersedeNode).toHaveBeenCalledWith({
      ownerId: 'o1',
      id: 'n-1',
      supersededBy: PAGE_ID,
      reason: 'migrated',
    });
    expect(outputOf(res).source_superseded).toBe(true);
  });

  it('leaves the note at full weight when supersede_source is false', async () => {
    const res = await fromNote.handler({ note_id: 'n-1', supersede_source: false }, ctx);
    expect(supersedeNode).not.toHaveBeenCalled();
    expect(outputOf(res).source_superseded).toBe(false);
  });

  it('still succeeds when the lineage stamp fails, and says the stamp did not land', async () => {
    vi.mocked(supersedeNode).mockRejectedValue(new Error('db down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await fromNote.handler({ note_id: 'n-1' }, ctx);
    spy.mockRestore();
    // The page exists; hiding that behind an error would invite a retry that
    // creates a second page.
    expect(outputOf(res)).toMatchObject({ id: PAGE_ID, source_superseded: false });
  });

  it('turns a parent-page miss into a teaching error naming the id', async () => {
    vi.mocked(createPage).mockRejectedValue(new Error('createPage: parent page not found'));
    const res = await fromNote.handler({ note_id: 'n-1', parent_id: 'p-nope' }, ctx);
    expect(errorOf(res)).toContain('p-nope');
    expect(supersedeNode).not.toHaveBeenCalled();
  });
});

describe('page_from_notes', () => {
  it('requires at least one id and a title, reading nothing without them', async () => {
    expect(errorOf(await fromNotes.handler({ note_ids: [], title: 'T' }, ctx))).toMatch(
      /note_ids is required/,
    );
    expect(errorOf(await fromNotes.handler({ note_ids: ['n-1'], title: ' ' }, ctx))).toMatch(
      /title is required/,
    );
    expect(getNote).not.toHaveBeenCalled();
  });

  it('fails the WHOLE call when any note is missing, naming only the missing ones', async () => {
    vi.mocked(getNote).mockImplementation(
      async (_o, id) => (id === 'n-2' ? null : note(id)) as never,
    );
    const res = await fromNotes.handler({ note_ids: ['n-1', 'n-2', 'n-3'], title: 'T' }, ctx);
    // A half-built page from the notes that did resolve is worse than no page.
    expect(errorOf(res)).toContain('n-2');
    expect(errorOf(res)).not.toContain('n-1');
    expect(createPage).not.toHaveBeenCalled();
  });

  it('sections each note under its title, in the order given', async () => {
    const res = await fromNotes.handler({ note_ids: ['n-2', 'n-1'], title: 'Combined' }, ctx);
    expect(parsedMarkdown()).toBe('## Note n-2\n\nbody of n-2\n\n## Note n-1\n\nbody of n-1');
    expect(createPage).toHaveBeenCalledWith(
      'o1',
      // Tags default to the union of the sources' tags.
      expect.objectContaining({ title: 'Combined', tags: ['t-n-2', 't-n-1'] }),
    );
    expect(outputOf(res)).toMatchObject({
      note_count: 2,
      source_note_ids: ['n-2', 'n-1'],
      sources_superseded: 2,
    });
  });

  it('concatenates raw when headings is false', async () => {
    await fromNotes.handler({ note_ids: ['n-1', 'n-2'], title: 'T', headings: false }, ctx);
    expect(parsedMarkdown()).toBe('body of n-1\n\nbody of n-2');
  });

  it('dedupes the tag union and lets explicit tags override it', async () => {
    vi.mocked(getNote).mockImplementation(async (_o, id) => note(id, { tags: ['same'] }) as never);
    await fromNotes.handler({ note_ids: ['n-1', 'n-2'], title: 'T' }, ctx);
    expect(createPage).toHaveBeenLastCalledWith('o1', expect.objectContaining({ tags: ['same'] }));

    await fromNotes.handler({ note_ids: ['n-1', 'n-2'], title: 'T', tags: ['mine'] }, ctx);
    expect(createPage).toHaveBeenLastCalledWith('o1', expect.objectContaining({ tags: ['mine'] }));
  });

  it('supersedes every source, counting only the stamps that landed', async () => {
    vi.mocked(supersedeNode).mockImplementation(async (input) => {
      if (input.id === 'n-2') throw new Error('db down');
      return {} as never;
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await fromNotes.handler({ note_ids: ['n-1', 'n-2', 'n-3'], title: 'T' }, ctx);
    spy.mockRestore();
    expect(supersedeNode).toHaveBeenCalledTimes(3);
    expect(supersedeNode).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'o1', id: 'n-3', supersededBy: PAGE_ID }),
    );
    expect(outputOf(res).sources_superseded).toBe(2);
  });

  it('leaves the sources alone when supersede_source is false', async () => {
    const res = await fromNotes.handler(
      { note_ids: ['n-1'], title: 'T', supersede_source: false },
      ctx,
    );
    expect(supersedeNode).not.toHaveBeenCalled();
    expect(outputOf(res).sources_superseded).toBe(0);
  });
});

describe('page_from_journal', () => {
  it('requires at least one id and a title, reading nothing without them', async () => {
    expect(errorOf(await fromJournal.handler({ journal_ids: [], title: 'T' }, ctx))).toMatch(
      /journal_ids is required/,
    );
    expect(errorOf(await fromJournal.handler({ journal_ids: ['j-1'] }, ctx))).toMatch(
      /title is required/,
    );
    expect(getJournal).not.toHaveBeenCalled();
  });

  it('fails the WHOLE call when any entry is missing', async () => {
    vi.mocked(getJournal).mockImplementation(
      async (_o, id) => (id === 'j-9' ? null : entry(id)) as never,
    );
    const res = await fromJournal.handler({ journal_ids: ['j-1', 'j-9'], title: 'T' }, ctx);
    expect(errorOf(res)).toContain('j-9');
    expect(errorOf(res)).toMatch(/journal_list/);
    expect(createPage).not.toHaveBeenCalled();
  });

  it('heads each entry with its date then title, in the order given', async () => {
    const res = await fromJournal.handler({ journal_ids: ['j-2', 'j-1'], title: 'Week' }, ctx);
    const md = parsedMarkdown();
    const sections = md.split('\n\n');
    expect(sections).toHaveLength(4);
    expect(sections[0]).toMatch(/^## 2026-09-01 .*Entry j-2$/);
    expect(sections[1]).toBe('journal j-2');
    expect(sections[2]).toMatch(/^## 2026-09-01 .*Entry j-1$/);
    expect(sections[3]).toBe('journal j-1');
    expect(getJournal).toHaveBeenCalledWith('o1', 'j-2');
    expect(outputOf(res)).toMatchObject({ entry_count: 2, source_journal_ids: ['j-2', 'j-1'] });
  });

  it('falls back to the created date when the entry has no entry date', async () => {
    // getJournal collapses a blank entry_date to null (never ''), which is
    // what lets the `??` fallback fire.
    vi.mocked(getJournal).mockImplementation(
      async (_o, id) => entry(id, { entryDate: null, title: '' }) as never,
    );
    await fromJournal.handler({ journal_ids: ['j-1'], title: 'T' }, ctx);
    expect(parsedMarkdown()).toBe('## 2026-09-02\n\njournal j-1');
  });

  it('concatenates raw when headings is false', async () => {
    await fromJournal.handler({ journal_ids: ['j-1', 'j-2'], title: 'T', headings: false }, ctx);
    expect(parsedMarkdown()).toBe('journal j-1\n\njournal j-2');
  });

  it('leaves the entries IN PLACE: no supersede, ever', async () => {
    await fromJournal.handler({ journal_ids: ['j-1', 'j-2'], title: 'T' }, ctx);
    // The journal is a chronological log; compiling it is a view, not a move.
    expect(supersedeNode).not.toHaveBeenCalled();
    expect(createPage).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({ tags: ['j-j-1', 'j-j-2'] }),
    );
  });
});

describe('page_from_file', () => {
  it('refuses a blank file id without reading anything', async () => {
    expect(errorOf(await fromFile.handler({ file_id: ' ' }, ctx))).toMatch(/file_id is required/);
    expect(fileById).not.toHaveBeenCalled();
  });

  it('reports a missing file with the lookup that fixes it', async () => {
    vi.mocked(fileById).mockResolvedValue(null as never);
    expect(errorOf(await fromFile.handler({ file_id: FILE_ID }, ctx))).toMatch(/file_list/);
    expect(fileById).toHaveBeenCalledWith({ ownerId: 'o1', fileId: FILE_ID });
    expect(readFileById).not.toHaveBeenCalled();
  });

  it('rejects a binary before reading its bytes', async () => {
    vi.mocked(fileById).mockResolvedValue(
      fileMeta({ filename: 'deck.pdf', mimeType: 'application/pdf', isText: false }) as never,
    );
    const res = await fromFile.handler({ file_id: FILE_ID }, ctx);
    expect(errorOf(res)).toMatch(/binary/);
    expect(errorOf(res)).toContain('deck.pdf');
    expect(readFileById).not.toHaveBeenCalled();
    expect(createPage).not.toHaveBeenCalled();
  });

  it('imports the bytes server-side and titles the page from the basename', async () => {
    const res = await fromFile.handler({ file_id: FILE_ID, tags: ['import'] }, ctx);
    expect(readFileById).toHaveBeenCalledWith({ ownerId: 'o1', fileId: FILE_ID });
    expect(parsedMarkdown()).toBe('# Launch\n\nGo.');
    expect(createPage).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({ title: 'Launch plan', tags: ['import'] }),
    );
    expect(outputOf(res)).toMatchObject({
      id: PAGE_ID,
      source_file_id: FILE_ID,
      source_byte_size: Buffer.byteLength('# Launch\n\nGo.'),
      source_superseded: true,
    });
    expect(supersedeNode).toHaveBeenCalledWith({
      ownerId: 'o1',
      id: FILE_ID,
      supersededBy: PAGE_ID,
      reason: 'migrated',
    });
  });

  it('recovers the slug from a timestamped upload name, and lets an explicit title win', async () => {
    vi.mocked(fileById).mockResolvedValue(
      fileMeta({
        filename: '1779877120189-he-is-the-potter-3621047f3c9e80ba96a9e6f6c08.md',
      }) as never,
    );
    await fromFile.handler({ file_id: FILE_ID }, ctx);
    expect(createPage).toHaveBeenLastCalledWith(
      'o1',
      expect.objectContaining({ title: 'He is the potter' }),
    );

    await fromFile.handler({ file_id: FILE_ID, title: 'Given' }, ctx);
    expect(createPage).toHaveBeenLastCalledWith('o1', expect.objectContaining({ title: 'Given' }));
  });

  it('keeps the file at full weight when supersede_source is false', async () => {
    const res = await fromFile.handler({ file_id: FILE_ID, supersede_source: false }, ctx);
    expect(supersedeNode).not.toHaveBeenCalled();
    expect(outputOf(res).source_superseded).toBe(false);
  });

  it('still succeeds when the lineage stamp fails', async () => {
    vi.mocked(supersedeNode).mockRejectedValue(new Error('db down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await fromFile.handler({ file_id: FILE_ID }, ctx);
    spy.mockRestore();
    expect(outputOf(res)).toMatchObject({ id: PAGE_ID, source_superseded: false });
  });
});

describe('page_replace_from_file', () => {
  const input = { page_id: 'p-1', file_id: FILE_ID };

  it('requires both ids, reading nothing without them', async () => {
    expect(errorOf(await replaceFromFile.handler({ file_id: FILE_ID }, ctx))).toMatch(
      /page_id is required/,
    );
    expect(errorOf(await replaceFromFile.handler({ page_id: 'p-1' }, ctx))).toMatch(
      /file_id is required/,
    );
    expect(getPage).not.toHaveBeenCalled();
    expect(fileById).not.toHaveBeenCalled();
  });

  it('checks the page BEFORE touching the file', async () => {
    vi.mocked(getPage).mockResolvedValue(null as never);
    expect(errorOf(await replaceFromFile.handler(input, ctx))).toMatch(/page_list/);
    expect(getPage).toHaveBeenCalledWith('o1', 'p-1');
    expect(fileById).not.toHaveBeenCalled();
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('rejects a binary before reading its bytes', async () => {
    vi.mocked(fileById).mockResolvedValue(
      fileMeta({ filename: 'deck.pdf', mimeType: 'application/pdf', isText: false }) as never,
    );
    expect(errorOf(await replaceFromFile.handler(input, ctx))).toMatch(/binary/);
    expect(readFileById).not.toHaveBeenCalled();
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('writes the new body to the DRAFT unconditionally, and leaves metadata alone', async () => {
    const res = await replaceFromFile.handler(input, ctx);
    expect(parsedMarkdown()).toBe('# Launch\n\nGo.');
    // Exactly three args: no baseRev. The body is built wholesale from the
    // file, so there is no read-modify-write race to protect.
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveDraft).mock.calls[0]).toEqual([
      'o1',
      'p-1',
      expect.objectContaining({ type: 'doc' }),
    ]);
    expect(updatePage).not.toHaveBeenCalled();
    expect(outputOf(res)).toMatchObject({
      page_id: 'p-1',
      draft_saved: true,
      meta_updated: false,
    });
    expect(String(outputOf(res).hint)).toMatch(/DRAFT/);
  });

  it('patches only the metadata given, via the published row, never with a doc', async () => {
    const res = await replaceFromFile.handler(
      { ...input, title: 'Renamed', tags: ['recall', 'ops'] },
      ctx,
    );
    // Title and tags reach the nodes row (owner-only tag stripped); the body
    // still goes to the draft. updatePage must not carry a doc, or the
    // published page would change without a commit.
    expect(updatePage).toHaveBeenCalledWith('o1', 'p-1', { title: 'Renamed', tags: ['ops'] });
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(outputOf(res).meta_updated).toBe(true);
  });

  it('does not claim a draft landed when the save says the page is gone', async () => {
    vi.mocked(saveDraft).mockResolvedValue({ ok: false, missing: true } as never);
    expect(errorOf(await replaceFromFile.handler(input, ctx))).toMatch(/disappeared/);
  });
});
