import { describe, expect, it } from 'vitest';
import * as tablesApi from './tables';

/**
 * `@mantle/content/tables` is a PUBLIC package sub-path (see package.json
 * `exports`; server/web/lib/tables.ts is the caller), so its export list is a
 * promise rather than an implementation detail.
 *
 * The 2026-09-02 split of the 951-line tables.ts into tables/{shared,workbook,
 * read,write,draft}.ts forced a dozen internals to become cross-module
 * exports. `assertTableWritable` is the one that matters most: it is the guard
 * that refuses a grid edit on an app-bound table, and offering it as API
 * invites a caller to reach past it. This pins the surface so relaxing the
 * barrel to `export *` fails a test instead of quietly widening the contract.
 *
 * Runtime values only: `import *` cannot see type-only exports. The nine
 * exported types are pinned by the compiler, via index-tables.ts and
 * server/web/lib/tables.ts.
 */
const PUBLIC_VALUE_EXPORTS = [
  'AppBoundTableError',
  'TABLES_ROOT_LABEL',
  'applyTableOps',
  'commitTable',
  'countTables',
  'createTable',
  'deleteTable',
  'discardTableDraft',
  'getTable',
  'listTableTags',
  'listTables',
  'saveTableDraft',
  'updateTable',
];

/** Helpers the split made cross-module. None of them is API. */
const MUST_STAY_INTERNAL = [
  'assertTableWritable',
  'appExportLinkOf',
  'appLinkOf',
  'rowOf',
  'detailOf',
  'docsOf',
  'countsOf',
  'countsFromRegistry',
  'tabsFromStats',
  'ensureRoot',
  'dedupeTags',
  'isWorkbook',
  'guardSingleTabWrite',
  'statsOrNull',
  'effectiveTabCount',
  'effectiveTabName',
];

describe('@mantle/content/tables public surface', () => {
  it('exports exactly the pinned list', () => {
    expect(Object.keys(tablesApi).sort()).toEqual([...PUBLIC_VALUE_EXPORTS].sort());
  });

  it('does not leak the split helpers', () => {
    for (const name of MUST_STAY_INTERNAL) {
      expect(Object.keys(tablesApi)).not.toContain(name);
    }
  });
});
