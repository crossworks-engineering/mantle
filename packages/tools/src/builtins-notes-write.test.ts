/**
 * Behavioural tests for the four note WRITE tools: note_create,
 * note_update, note_from_file, note_from_page. None had one.
 *
 * note_update carries the property that matters most. Its `append` mode
 * exists so a log-style note can grow without the model re-emitting the whole
 * body, which means the tool READS the current body and writes a joined one.
 * If the read misses, the write must not happen: otherwise a stale id turns
 * "add today's entry" into a note containing only today's entry, reported as
 * success. The tests pin that ordering, and that `content` + `append`
 * together is refused before anything is read.
 *
 * The two import tools share one shape: resolve the source under the owner,
 * refuse what cannot be imported (a binary file, a missing page), and only
 * then create. The failure arms assert `createNote` never ran.
 *
 * The stores are stubbed; the tools' guards, title derivation, body joining
 * and ingest recording are real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...actual,
    createNote: vi.fn(),
    updateNote: vi.fn(),
    getNote: vi.fn(),
    getPage: vi.fn(),
    docToMarkdown: vi.fn(),
    nodeUrl: (id: string) => `https://brain.test/n/${id}`,
  };
});
vi.mock('@mantle/files', () => ({ fileById: vi.fn(), readFileById: vi.fn() }));
vi.mock('@mantle/tracing', () => ({ recordIngest: vi.fn(async () => undefined) }));

import { createNote, updateNote, getNote, getPage, docToMarkdown } from '@mantle/content';
import { fileById, readFileById } from '@mantle/files';
import { recordIngest } from '@mantle/tracing';
import { NOTE_TOOLS } from './builtins-notes';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const ID = '11111111-2222-4333-8444-555555555555';
const FILE_ID = '22222222-2222-4333-8444-555555555555';
const PAGE_ID = '33333333-2222-4333-8444-555555555555';

const create = NOTE_TOOLS.find((t) => t.slug === 'note_create')!;
const update = NOTE_TOOLS.find((t) => t.slug === 'note_update')!;
const fromFile = NOTE_TOOLS.find((t) => t.slug === 'note_from_file')!;
const fromPage = NOTE_TOOLS.find((t) => t.slug === 'note_from_page')!;

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

const noteRow = { id: ID, title: 'Work log', content: 'day 1', tags: ['log'] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createNote).mockResolvedValue(noteRow as never);
  vi.mocked(updateNote).mockResolvedValue(noteRow as never);
  vi.mocked(getNote).mockResolvedValue(noteRow as never);
  vi.mocked(recordIngest).mockResolvedValue(undefined as never);
});

describe('note_create', () => {
  it('refuses a blank title WITHOUT creating or recording anything', async () => {
    expect(errorOf(await create.handler({ title: '  ', content: 'x' }, ctx))).toMatch(/title/);
    expect(createNote).not.toHaveBeenCalled();
    expect(recordIngest).not.toHaveBeenCalled();
  });

  it('creates under the owner and records the ingest against the new node', async () => {
    const res = await create.handler(
      { title: '  Work log  ', content: 'day 1', tags: ['log', null] },
      ctx,
    );

    expect(createNote).toHaveBeenCalledWith('o1', {
      title: 'Work log',
      content: 'day 1',
      tags: ['log'],
    });
    // The biography entry is what stops the note "appearing from nowhere".
    expect(recordIngest).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'o1', nodeId: ID, source: 'agent_tool' }),
    );
    expect(outputOf(res)).toMatchObject({ id: ID, title: 'Work log' });
  });

  it('caps the title at 200 characters before the store sees it', async () => {
    await create.handler({ title: 'x'.repeat(300) }, ctx);
    expect(createNote).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({ title: 'x'.repeat(200) }),
    );
  });
});

describe('note_update', () => {
  it('refuses content + append together, before any read', async () => {
    expect(errorOf(await update.handler({ id: ID, content: 'a', append: 'b' }, ctx))).toMatch(
      /content OR append/,
    );
    expect(getNote).not.toHaveBeenCalled();
    expect(updateNote).not.toHaveBeenCalled();
  });

  it('refuses an empty patch rather than issuing a no-op write', async () => {
    expect(errorOf(await update.handler({ id: ID }, ctx))).toMatch(/nothing to change/);
    expect(updateNote).not.toHaveBeenCalled();
  });

  it('append reads the current body under the owner and writes the joined result', async () => {
    vi.mocked(getNote).mockResolvedValue({ ...noteRow, content: 'day 1\n\n' } as never);

    const res = await update.handler({ id: ID, append: 'day 2' }, ctx);

    expect(getNote).toHaveBeenCalledWith('o1', ID);
    // Trailing whitespace is trimmed and exactly one blank line separates.
    expect(updateNote).toHaveBeenCalledWith('o1', ID, { content: 'day 1\n\nday 2' });
    expect(outputOf(res)).toMatchObject({ id: ID, appended: true });
  });

  it('append on a missing note fails at the READ and never writes', async () => {
    vi.mocked(getNote).mockResolvedValue(null);

    const err = errorOf(await update.handler({ id: ID, append: 'day 2' }, ctx));

    expect(err).toMatch(/not found/i);
    // THE property: a stale id must not become a note holding only the
    // appended fragment.
    expect(updateNote).not.toHaveBeenCalled();
  });

  it('a metadata-only patch sends just those keys (no body) and reads nothing', async () => {
    await update.handler({ id: ID, title: 'Renamed', tags: ['a'] }, ctx);
    expect(getNote).not.toHaveBeenCalled();
    expect(updateNote).toHaveBeenCalledWith('o1', ID, { title: 'Renamed', tags: ['a'] });
  });

  it('translates a store miss into not-found naming the lookup', async () => {
    vi.mocked(updateNote).mockResolvedValue(null);
    const err = errorOf(await update.handler({ id: ID, title: 'x' }, ctx));
    expect(err).toMatch(/not found/i);
    expect(err).toMatch(/note_list/);
  });
});

describe('note_from_file', () => {
  it('refuses a file the owner does not hold, without reading bytes or creating', async () => {
    vi.mocked(fileById).mockResolvedValue(null);

    const err = errorOf(await fromFile.handler({ file_id: FILE_ID }, ctx));

    expect(fileById).toHaveBeenCalledWith({ ownerId: 'o1', fileId: FILE_ID });
    expect(err).toMatch(/not found/i);
    expect(readFileById).not.toHaveBeenCalled();
    expect(createNote).not.toHaveBeenCalled();
  });

  it('refuses a binary file and points at file_get instead', async () => {
    vi.mocked(fileById).mockResolvedValue({
      filename: 'spec.pdf',
      mimeType: 'application/pdf',
      isText: false,
    } as never);

    const err = errorOf(await fromFile.handler({ file_id: FILE_ID }, ctx));

    expect(err).toMatch(/binary/);
    expect(err).toMatch(/file_get/);
    expect(createNote).not.toHaveBeenCalled();
  });

  it('imports the bytes verbatim and derives the title from the upload name', async () => {
    vi.mocked(fileById).mockResolvedValue({
      filename: '1720000000000-work-log-abcdef0123456789abcdef.md',
      mimeType: 'text/markdown',
      isText: true,
    } as never);
    vi.mocked(readFileById).mockResolvedValue({ bytes: Buffer.from('# Log\n\nday 1') } as never);

    const res = await fromFile.handler({ file_id: FILE_ID, tags: ['log'] }, ctx);

    expect(readFileById).toHaveBeenCalledWith({ ownerId: 'o1', fileId: FILE_ID });
    expect(createNote).toHaveBeenCalledWith('o1', {
      // The collision-safe upload name is unwrapped, not shown to the user.
      title: 'Work log',
      content: '# Log\n\nday 1',
      tags: ['log'],
    });
    expect(recordIngest).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'o1', nodeId: ID }),
    );
    expect(outputOf(res)).toMatchObject({ id: ID, source_file_id: FILE_ID, source_byte_size: 12 });
  });
});

describe('note_from_page', () => {
  it('refuses a missing page under the owner without creating', async () => {
    vi.mocked(getPage).mockResolvedValue(null);

    const err = errorOf(await fromPage.handler({ page_id: PAGE_ID }, ctx));

    expect(getPage).toHaveBeenCalledWith('o1', PAGE_ID);
    expect(err).toMatch(/not found/i);
    expect(err).toMatch(/page_list/);
    expect(createNote).not.toHaveBeenCalled();
  });

  it('serialises the page doc server-side and inherits its title and tags', async () => {
    vi.mocked(getPage).mockResolvedValue({
      id: PAGE_ID,
      title: 'Runbook',
      tags: ['ops'],
      doc: { type: 'doc', content: [] },
    } as never);
    vi.mocked(docToMarkdown).mockReturnValue('# Runbook\n\nsteps');

    const res = await fromPage.handler({ page_id: PAGE_ID }, ctx);

    expect(docToMarkdown).toHaveBeenCalledWith({ type: 'doc', content: [] });
    expect(createNote).toHaveBeenCalledWith('o1', {
      title: 'Runbook',
      content: '# Runbook\n\nsteps',
      tags: ['ops'],
    });
    expect(outputOf(res)).toMatchObject({ id: ID, source_page_id: PAGE_ID });
  });
});
