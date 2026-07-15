import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { describeWorkbook, writeDocFile } from './engine';
import { schemaDigest, schemaToText } from './schema';
import type { TableDocLike } from './doc-types';

const dir = mkdtempSync(path.join(tmpdir(), 'tabledb-schema-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const META = { nodeId: 'node-s1', ownerId: 'owner-1' };

function carsDoc(): TableDocLike {
  return {
    columns: [
      { id: 'c-model', name: 'Model', type: 'text' },
      { id: 'c-make', name: 'Make', type: 'text' },
      { id: 'c-year', name: 'Year', type: 'number' },
      { id: 'c-ev', name: 'EV', type: 'checkbox' },
      { id: 'c-total', name: 'Total', type: 'formula', formula: '{Year} * 2' },
    ],
    rows: [
      { id: 'r1', cells: { 'c-model': 'Corolla', 'c-make': 'Toyota', 'c-year': 2024, 'c-ev': false } },
      { id: 'r2', cells: { 'c-model': 'Model 3', 'c-make': 'Tesla', 'c-year': 2025, 'c-ev': true } },
    ],
  };
}

function writtenTabs(name: string) {
  const abs = path.join(dir, `${name}.sqlite`);
  writeDocFile(abs, carsDoc(), { ...META, tabName: 'Fleet', fts: true });
  return describeWorkbook(abs);
}

describe('schemaToText', () => {
  it('renders the data dictionary with tab shape, columns, and SQL surface', () => {
    const tabs = writtenTabs('dict');
    const text = schemaToText(tabs, { title: 'Car models', nodeId: 'node-s1' });
    expect(text).toContain('# Car models — table schema');
    expect(text).toContain('Table id: node-s1');
    expect(text).toContain('Fleet (2 rows × 4 cols)');
    expect(text).toContain('## Fleet');
    expect(text).toContain('View "Fleet"');
    expect(text).toContain('FTS shadow');
    expect(text).toContain('Columns: Model (text), Make (text), Year (number), EV (checkbox).');
    // Formula columns have no storage — they must not appear as queryable.
    expect(text).not.toContain('Total');
  });

  it('omits the node id line when not provided and survives empty workbooks', () => {
    const text = schemaToText([], { title: 'Empty' });
    expect(text).toContain('# Empty — table schema');
    expect(text).not.toContain('Table id:');
    expect(text).toContain('Tabs: none.');
  });
});

describe('schemaDigest', () => {
  it('renders one line of tab shape + column names', () => {
    const tabs = writtenTabs('digest');
    expect(schemaDigest(tabs)).toBe('Fleet(2r): Model, Make, Year, EV');
  });

  it('hard-caps the digest with an ellipsis', () => {
    const tabs = writtenTabs('cap');
    const digest = schemaDigest(tabs, 20);
    expect(digest.length).toBe(20);
    expect(digest.endsWith('…')).toBe(true);
  });
});
