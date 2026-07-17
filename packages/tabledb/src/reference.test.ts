import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { describeWorkbook, readDocFile, writeDocFile } from './engine';
import { applyOpsToFile } from './ops';
import { profileFile, profileToText } from './profile';
import { schemaToText } from './schema';
import { openTableFile } from './sqlite';
import { distinctColumnValues, queryRowsWindow } from './window';
import type { CellValue, WorkbookDocLike } from './doc-types';

const dir = mkdtempSync(path.join(tmpdir(), 'tabledb-ref-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const META = { nodeId: 'node-r1', ownerId: 'owner-1' };
const coerce = (v: unknown): CellValue => v as CellValue;

/** Two tabs: Car models (source) + Orders whose Model column REFERENCES it.
 *  ORD-3 carries a dangling value ('DeLorean' is not a model). */
function workbook(): WorkbookDocLike {
  return {
    tabs: [
      {
        id: 'models',
        name: 'Car models',
        columns: [
          { id: 'c-model', name: 'Model', type: 'text' },
          { id: 'c-make', name: 'Make', type: 'text' },
        ],
        rows: [
          { id: 'm1', cells: { 'c-model': 'Corolla', 'c-make': 'Toyota' } },
          { id: 'm2', cells: { 'c-model': 'Model 3', 'c-make': 'Tesla' } },
        ],
      },
      {
        id: 'orders',
        name: 'Orders',
        columns: [
          { id: 'c-ref', name: 'Ref', type: 'text' },
          {
            id: 'c-omodel',
            name: 'Model',
            type: 'reference',
            ref: { tabId: 'models', columnId: 'c-model' },
          },
        ],
        rows: [
          { id: 'o1', cells: { 'c-ref': 'ORD-1', 'c-omodel': 'Corolla' } },
          { id: 'o2', cells: { 'c-ref': 'ORD-2', 'c-omodel': 'Model 3' } },
          { id: 'o3', cells: { 'c-ref': 'ORD-3', 'c-omodel': 'DeLorean' } },
        ],
      },
    ],
  };
}

function write(name: string) {
  const abs = path.join(dir, `${name}.sqlite`);
  writeDocFile(abs, workbook(), { ...META, fts: true });
  return abs;
}

describe('reference columns', () => {
  it('persist through write → read round-trip', () => {
    const abs = write('roundtrip');
    const orders = readDocFile(abs, { tabId: 'orders' });
    const col = orders.columns.find((c) => c.id === 'c-omodel')!;
    expect(col.type).toBe('reference');
    expect(col.ref).toEqual({ tabId: 'models', columnId: 'c-model' });
  });

  it('describeWorkbook resolves the edge to display names', () => {
    const abs = write('describe');
    const orders = describeWorkbook(abs).find((t) => t.name === 'Orders')!;
    const col = orders.columns.find((c) => c.name === 'Model')!;
    expect(col.refersTo).toEqual({ tab: 'Car models', column: 'Model' });
  });

  it('schemaToText states the join edge', () => {
    const abs = write('schema');
    const text = schemaToText(describeWorkbook(abs), { title: 'Fleet' });
    expect(text).toContain('Join edge: "Orders"."Model" references "Car models"."Model"');
  });

  it('profile flags dangling values and names the source', () => {
    const abs = write('dangling');
    const orders = profileFile(abs).find((t) => t.name === 'Orders')!;
    const col = orders.columns.find((c) => c.name === 'Model')!;
    expect(col.refersTo).toEqual({ tab: 'Car models', column: 'Model' });
    expect(col.danglingRefs).toBe(1); // DeLorean
    const text = profileToText(profileFile(abs), { title: 'Fleet' });
    expect(text).toContain('references Car models.Model');
    expect(text).toContain('DANGLING REFS (1');
  });

  it('values behave as text: eq pushdown + distinct option list', () => {
    const abs = write('query');
    const q = queryRowsWindow(abs, {
      tabId: 'orders',
      filters: [{ colId: 'c-omodel', op: 'eq', value: 'Corolla' }],
    });
    expect(q?.rows.map((r) => r.id)).toEqual(['o1']);
    // The editor's dropdown source: distinct values of the SOURCE column.
    expect(distinctColumnValues(abs, { columnId: 'c-model', tabId: 'models' })).toEqual([
      'Corolla',
      'Model 3',
    ]);
    expect(
      distinctColumnValues(abs, { columnId: 'c-model', tabId: 'models', prefix: 'Cor' }),
    ).toEqual(['Corolla']);
  });

  it('column_add validates the target exists and is not a formula/self', () => {
    const abs = write('validate');
    expect(() =>
      applyOpsToFile(
        abs,
        [
          {
            op: 'column_add',
            tabId: 'orders',
            column: {
              id: 'c-bad',
              name: 'Bad',
              type: 'reference',
              ref: { tabId: 'models', columnId: 'nope' },
            },
          },
        ],
        coerce,
      ),
    ).toThrow(/does not exist/);
    expect(() =>
      applyOpsToFile(
        abs,
        [
          {
            op: 'column_add',
            tabId: 'orders',
            column: {
              id: 'c-self',
              name: 'Self',
              type: 'reference',
              ref: { tabId: 'orders', columnId: 'c-self' },
            },
          },
        ],
        coerce,
      ),
    ).toThrow(/reference itself/);
    // valid add works and persists
    applyOpsToFile(
      abs,
      [
        {
          op: 'column_add',
          tabId: 'models',
          column: {
            id: 'c-made-by',
            name: 'Made by',
            type: 'reference',
            ref: { tabId: 'models', columnId: 'c-make' },
          },
        },
      ],
      coerce,
    );
    const models = readDocFile(abs, { tabId: 'models' });
    expect(models.columns.find((c) => c.id === 'c-made-by')?.ref).toEqual({
      tabId: 'models',
      columnId: 'c-make',
    });
  });

  it('retyping away from reference clears the edge; deleting the source degrades it', () => {
    const abs = write('degrade');
    applyOpsToFile(
      abs,
      [{ op: 'column_update', tabId: 'orders', columnId: 'c-omodel', patch: { type: 'text' } }],
      coerce,
    );
    const orders = readDocFile(abs, { tabId: 'orders' });
    const col = orders.columns.find((c) => c.id === 'c-omodel')!;
    expect(col.type).toBe('text');
    expect(col.ref).toBeUndefined();
    // Values survive the retype verbatim (Excel semantics).
    expect(orders.rows.find((r) => r.id === 'o3')?.cells['c-omodel']).toBe('DeLorean');

    // Fresh file: delete the SOURCE column — the edge stops being advertised,
    // the referencing column keeps its values.
    const abs2 = write('degrade2');
    applyOpsToFile(abs2, [{ op: 'column_delete', tabId: 'models', columnId: 'c-model' }], coerce);
    const described = describeWorkbook(abs2).find((t) => t.name === 'Orders')!;
    expect(described.columns.find((c) => c.name === 'Model')?.refersTo).toBeUndefined();
    expect(
      readDocFile(abs2, { tabId: 'orders' }).rows.find((r) => r.id === 'o1')?.cells['c-omodel'],
    ).toBe('Corolla');
  });

  it('pre-v2.1 files (no ref_json column) lazily upgrade on first ops write', () => {
    // Simulate an old file by dropping the column.
    const abs = write('upgrade');
    const db = openTableFile(abs);
    // SQLite can't DROP a PK-adjacent column easily pre-3.35; rebuild _columns without ref_json.
    db.exec(
      `CREATE TABLE _columns_old AS SELECT tab_id, col_id, physical, name, type, format_json, options_json, formula_src, width, position FROM _columns WHERE type != 'reference'`,
    );
    db.exec(`DROP TABLE _columns`);
    db.exec(`ALTER TABLE _columns_old RENAME TO _columns`);
    db.close();
    // Ops on the old-shape file work, including adding a reference column.
    applyOpsToFile(
      abs,
      [
        {
          op: 'column_add',
          tabId: 'models',
          column: {
            id: 'c-again',
            name: 'Again',
            type: 'reference',
            ref: { tabId: 'models', columnId: 'c-make' },
          },
        },
      ],
      coerce,
    );
    expect(
      readDocFile(abs, { tabId: 'models' }).columns.find((c) => c.id === 'c-again')?.ref,
    ).toEqual({
      tabId: 'models',
      columnId: 'c-make',
    });
  });
});
