/**
 * The task file tools (files on tasks, plan page 74b70ac6): task_file_add,
 * task_file_get and task_file_remove. The store calls are stubbed; the
 * tools' own guards and answers are real. The rights and caps are proved on
 * Postgres in @mantle/content task-files.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return { ...actual, addTaskFile: vi.fn(), readTaskFile: vi.fn(), removeTaskFile: vi.fn() };
});

import { addTaskFile, readTaskFile, removeTaskFile } from '@mantle/content';
import { TASK_TOOLS } from './builtins-tasks';
import type { ToolHandlerContext } from './types';

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const TASK = '11111111-2222-4333-8444-555555555555';
const FILE = '66666666-7777-4888-9999-000000000000';
const tool = (slug: string) => TASK_TOOLS.find((t) => t.slug === slug)!;
const row = (filename: string, extension: string, mimeType: string) =>
  ({ id: FILE, filename, extension, mimeType, sizeBytes: 4 }) as never;

beforeEach(() => vi.resetAllMocks());

describe('task_file_remove', () => {
  it('a file on the task: removed', async () => {
    vi.mocked(removeTaskFile).mockResolvedValue(true);
    const res = await tool('task_file_remove').handler({ id: TASK, file_id: FILE }, ctx);
    expect(res).toEqual({ ok: true, output: { removed: true, id: TASK, fileId: FILE } });
    expect(removeTaskFile).toHaveBeenCalledWith('o1', TASK, FILE);
  });

  it('a file not on the task: an error, never a success', async () => {
    vi.mocked(removeTaskFile).mockResolvedValue(false);
    const res = await tool('task_file_remove').handler({ id: TASK, file_id: FILE }, ctx);
    expect(res.ok).toBe(false);
  });
});

describe('task_file_add', () => {
  it('takes text or base64, one of them', async () => {
    vi.mocked(addTaskFile).mockResolvedValue({
      id: FILE,
      filename: 'a.log',
      mimeType: 'text/plain',
      sizeBytes: 4,
      createdAt: '2026-11-09T00:00:00.000Z',
    });
    const ok = await tool('task_file_add').handler(
      { id: TASK, filename: 'a.log', content_text: 'boom' },
      ctx,
    );
    expect(ok.ok).toBe(true);
    const bytes = vi.mocked(addTaskFile).mock.calls[0]![0].bytes!;
    expect(bytes.toString()).toBe('boom');
    const both = await tool('task_file_add').handler(
      { id: TASK, filename: 'a.log', content_text: 'x', content_base64: 'eA==' },
      ctx,
    );
    expect(both.ok).toBe(false);
  });

  it("answers the store's refusal as an error", async () => {
    vi.mocked(addTaskFile).mockRejectedValue(new Error('A task holds at most 5 files.'));
    const res = await tool('task_file_add').handler(
      { id: TASK, filename: 'a.png', content_base64: 'eA==' },
      ctx,
    );
    expect(res).toEqual({ ok: false, error: 'task_file_add: A task holds at most 5 files.' });
  });
});

describe('task_file_get', () => {
  it('an image: a picture for the model', async () => {
    vi.mocked(readTaskFile).mockResolvedValue({
      row: row('shot.png', 'png', 'image/png'),
      bytes: Buffer.from('png!'),
    });
    const res = await tool('task_file_get').handler({ id: TASK, file_id: FILE }, ctx);
    expect(res.ok && res.modelImages).toEqual([
      { mimeType: 'image/png', base64: Buffer.from('png!').toString('base64') },
    ]);
  });

  it('a log: its words; a PDF: its name only; a file not on the task: an error', async () => {
    vi.mocked(readTaskFile).mockResolvedValueOnce({
      row: row('app.log', 'log', 'text/plain'),
      bytes: Buffer.from('line 1'),
    });
    const log = await tool('task_file_get').handler({ id: TASK, file_id: FILE }, ctx);
    expect(log.ok && (log.output as { content: string }).content).toBe('line 1');
    vi.mocked(readTaskFile).mockResolvedValueOnce({
      row: row('spec.pdf', 'pdf', 'application/pdf'),
      bytes: Buffer.from('%PDF'),
    });
    const pdf = await tool('task_file_get').handler({ id: TASK, file_id: FILE }, ctx);
    expect(pdf.ok && (pdf.output as { content?: string }).content).toBeUndefined();
    vi.mocked(readTaskFile).mockResolvedValueOnce(null);
    const none = await tool('task_file_get').handler({ id: TASK, file_id: FILE }, ctx);
    expect(none.ok).toBe(false);
  });
});
