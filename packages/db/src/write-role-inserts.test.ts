import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableColumns, getTableName, isTable, type Table } from 'drizzle-orm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ACCESS_MATRIX, writeColumnsFor, writeRoleWrites } from './access-matrix';
import * as schema from './schema';

/**
 * A drizzle insert names every column of its table, sending the ones the
 * caller left out as DEFAULT. Postgres needs INSERT on each named column,
 * DEFAULT or not, so on a table where the write role (mantle_write_user)
 * holds INSERT on some columns only (writeColumnsFor answers a list), a
 * drizzle insert is refused for the role (42501) where raw text naming the
 * granted columns passes. Scoped code may run on the write role, so it
 * never makes a drizzle insert into such a table: it names the columns in
 * raw text (pinned by eslint-rules/no-raw-write-sql.mjs) or calls a
 * definer.
 */

/** The schema's export names of the tables the write role writes with a
 *  column list that leaves out at least one of the table's columns, with
 *  the columns it leaves out. */
function limitedInsertTables(): Map<string, { table: string; missing: string[] }> {
  const out = new Map<string, { table: string; missing: string[] }>();
  const byTable = new Map(
    ACCESS_MATRIX.filter(writeRoleWrites).map((t) => [t.table.replace(/^public\./, ''), t]),
  );
  for (const [name, value] of Object.entries(schema)) {
    if (!isTable(value)) continue;
    const table = value as Table;
    const access = byTable.get(getTableName(table));
    if (!access) continue;
    const write = writeColumnsFor(access);
    if (!Array.isArray(write)) continue;
    const missing = Object.values(getTableColumns(table))
      .map((c) => c.name)
      .filter((c) => !write.includes(c));
    if (missing.length) out.set(name, { table: getTableName(table), missing });
  }
  return out;
}

/** Each `.insert(<table>)` of `text` naming one of `names` (a schema
 *  export, bare, renamed by its import, or `schema.<name>`):
 *  `line: export name`. */
function limitedInserts(path: string, text: string, names: ReadonlySet<string>): string[] {
  if (!/\.insert\s*\(/.test(text)) return [];
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const local = new Map<string, string>();
  for (const st of sf.statements) {
    const bound = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : undefined;
    if (!bound || !ts.isNamedImports(bound)) continue;
    for (const el of bound.elements) local.set(el.name.text, (el.propertyName ?? el.name).text);
  }
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'insert' &&
      node.arguments.length === 1
    ) {
      const arg = node.arguments[0]!;
      const name = ts.isIdentifier(arg)
        ? (local.get(arg.text) ?? arg.text)
        : ts.isPropertyAccessExpression(arg)
          ? arg.name.text
          : null;
      if (name && names.has(name)) {
        out.push(`${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Scoped code: product code under packages/<name>/src and server/, no
 *  tests, test support or migrations (as eslint-rules/no-raw-write-sql.mjs
 *  reads it). */
function scopedFiles(root: string): string[] {
  const out = execFileSync('git', ['ls-files', 'packages', 'server'], {
    cwd: root,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter((f) => /^(packages\/[^/]+\/src\/|server\/).*\.(ts|tsx|mts)$/.test(f))
    .filter((f) => !/\.test\.(ts|tsx)$|\.d\.ts$/.test(f))
    .filter((f) => !/(^|\/)test-support(\/|\.ts$)/.test(f))
    .filter((f) => !f.includes('/migrations/'));
}

describe('drizzle inserts the write role may run', () => {
  const limited = limitedInsertTables();

  it('item_grants is such a table today (the guard is live)', () => {
    expect(limited.get('itemGrants')?.table).toBe('item_grants');
    expect(limited.get('itemGrants')?.missing).toEqual(
      expect.arrayContaining(['via_folder_id', 'granted_by', 'granted_at']),
    );
  });

  it('finds an insert by its export name, a renamed import and schema.<name>', () => {
    const names = new Set(['itemGrants']);
    const text = [
      "import { itemGrants as ig, nodes } from '@mantle/db';",
      'await tx.insert(itemGrants).values(v);',
      'await tx.insert(ig).values(v);',
      'await tx.insert(schema.itemGrants).values(v);',
      'await tx.insert(nodes).values(v);',
      'await tx.execute(sql`insert into item_grants (node_id) values (1)`);',
    ].join('\n');
    expect(limitedInserts('x.ts', text, names)).toEqual([
      '2: itemGrants',
      '3: itemGrants',
      '4: itemGrants',
    ]);
  });

  it('no scoped code makes a drizzle insert into a table the write role inserts by column', () => {
    const root = join(__dirname, '..', '..', '..');
    const names = new Set(limited.keys());
    const found: string[] = [];
    for (const f of scopedFiles(root)) {
      for (const hit of limitedInserts(f, readFileSync(join(root, f), 'utf8'), names)) {
        found.push(`${f}:${hit}`);
      }
    }
    expect(found).toEqual([]);
  });
});
