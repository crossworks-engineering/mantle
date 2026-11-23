/**
 * The tabs of file_processing's `database`: file_sql's describe with its
 * overview, so a file of many tabs gives the tabs it describes and
 * `tablesListed` counts the rest. The answer is stood in here; the overview
 * itself is real in ../file-sql-overview.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ answer: vi.fn() }));
vi.mock('../builtins-file-sql', () => ({ fileSqlAnswer: h.answer }));

import { tablesOf } from './processing';

const tab = (name: string, rows: number) => ({ name, view: name, row_count: rows, columns: [] });

beforeEach(() => h.answer.mockReset());

describe('file_processing, the tabs of a database', () => {
  it('asks for the overview, and counts the listed tabs in tablesListed', async () => {
    h.answer.mockResolvedValue({
      kind: 'describe',
      output: {
        file_id: 'f',
        title: 'book.pdf',
        tabs: [tab('Pages', 10), tab('Tables', 40)],
        listed: { count: 40, in: 'Tables', how: 'h', find: 'f', columns: 'c' },
        hint: 'h',
      },
    });
    expect(await tablesOf('o', 'f')).toEqual({
      tables: [
        { name: 'Pages', rows: 10 },
        { name: 'Tables', rows: 40 },
      ],
      tablesListed: { count: 40, in: 'Tables' },
    });
    expect(h.answer).toHaveBeenCalledWith(
      'o',
      { fileId: 'f', sql: '', cap: undefined },
      { tableHint: false, overview: true },
    );
  });

  it('a file of few tabs: every tab, and no tablesListed', async () => {
    h.answer.mockResolvedValue({
      kind: 'describe',
      output: { file_id: 'f', title: 'v.csv', tabs: [tab('Sheet1', 3)], hint: 'h' },
    });
    expect(await tablesOf('o', 'f')).toEqual({ tables: [{ name: 'Sheet1', rows: 3 }] });
  });

  it('no describe answer: undefined, and the rest of the answer stands', async () => {
    h.answer.mockResolvedValue({ kind: 'none', message: 'No database yet.' });
    expect(await tablesOf('o', 'f')).toBeUndefined();
  });
});
