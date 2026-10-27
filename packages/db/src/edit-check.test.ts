/**
 * The edit check's declarations (workspaces arch A3a, docs/edit-check.md),
 * with no database: the derived-keys inventory against the code that
 * writes the keys, and the triggers the access matrix makes.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_MATRIX,
  APP_CODE_COLUMNS,
  APP_SWITCH_COLUMNS,
  EDIT_CHECK_MIGRATION_TRIGGERS,
  NODE_EDIT_COLUMNS,
  editCheckTriggers,
  writeRoleWrites,
  type TableAccess,
} from './access-matrix';
import {
  DERIVED_KEY_WRITERS,
  EXTRACTOR_USER_KEYS,
  GATEWAY_KEY_WRITERS,
  NODE_EXTRACTOR_KEYS,
  NODE_DERIVED_KEYS,
  NODE_PRESENTATION_KEYS,
} from './edit-check';

const ROOT = join(__dirname, '..', '..', '..');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const migration = (tag: string) => read(`packages/db/migrations/${tag}.sql`);

/** The string literals of a SQL ARRAY[...] after `marker` in `text`. */
function sqlArrayAfter(text: string, marker: string): string[] {
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`no ${marker}`);
  const open = text.indexOf('ARRAY[', at);
  const close = text.indexOf(']', open);
  return [
    ...text
      .slice(open, close)
      .replace(/--[^\n]*/g, '')
      .matchAll(/'([^']+)'/g),
  ].map((m) => m[1]!);
}

/** The keys a `jsonb_build_object(...)` applied to nodes.data names in a
 *  file: every string literal at a key position of its arguments. */
function dataKeysBuilt(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\$\{nodes\.data\}\s*\|\|\s*jsonb_build_object\(/g)) {
    let depth = 0;
    let i = m.index! + m[0].length;
    const args: string[] = [];
    let cur = '';
    for (; i < text.length; i++) {
      const c = text[i]!;
      if (c === '(' || c === '{') depth++;
      if ((c === ')' || c === '}') && depth === 0) break;
      if (c === ')' || c === '}') depth--;
      if (c === ',' && depth === 0) {
        args.push(cur.trim());
        cur = '';
        continue;
      }
      cur += c;
    }
    args.push(cur.trim());
    for (let k = 0; k < args.length; k += 2) {
      const key = /^'([A-Za-z_][A-Za-z0-9_]*)'$/.exec(args[k]!)?.[1];
      if (key) out.push(key);
    }
  }
  return out;
}

describe('the derived keys of nodes.data (A3a, plan 5.2: an inventory, pinned)', () => {
  it('every key names its writers, and each writer still writes it', () => {
    expect(NODE_DERIVED_KEYS.length).toBeGreaterThan(13);
    for (const [key, files] of Object.entries(DERIVED_KEY_WRITERS)) {
      expect(files.length, key).toBeGreaterThan(0);
      for (const f of files) {
        expect(existsSync(join(ROOT, f)), `${key}: ${f}`).toBe(true);
        expect(read(f).includes(key), `${key} in ${f}`).toBe(true);
      }
    }
  });

  it('the SQL list (mantle_node_derived_keys, 0281; the extractor keys, 0337; the presentation keys, 0335) is this list', () => {
    const m = migration('0281_edit_check_tables');
    // The extractor's keys, last replaced in 0337 (the parser's failure count).
    const extractor = sqlArrayAfter(
      migration('0337_parser_failures_key'),
      'mantle_node_extractor_keys"()',
    );
    expect(extractor).toEqual([...NODE_EXTRACTOR_KEYS]);
    expect(sqlArrayAfter(m, 'mantle_node_extractor_keys"()')).toEqual(
      NODE_EXTRACTOR_KEYS.filter((k) => k !== 'parser_failures'),
    );
    // The derived keys are the extractor's and the rest.
    const rest = sqlArrayAfter(m, 'mantle_node_derived_keys"()\n');
    expect([...extractor, ...rest].sort()).toEqual([...NODE_DERIVED_KEYS].sort());
    // The presentation keys, last replaced in 0335 (the tree's own key).
    const pres = sqlArrayAfter(
      migration('0335_tree_rank_presentation'),
      'mantle_node_presentation_keys"()',
    );
    expect(pres).toEqual([...NODE_PRESENTATION_KEYS]);
  });

  it('holds the snapshot copy’s 13 keys (0267), the parser’s count (0337) and the files’ byte keys', () => {
    const copy = sqlArrayAfter(
      migration('0267_workspaces_spaces_fold'),
      'mantle_snapshot_copy_node_trg"()',
    );
    expect(copy).toHaveLength(13);
    // The copy's trigger now reads the named list (0281): the same 13, and
    // the parser's failure count since 0337.
    expect([...copy, 'parser_failures'].sort()).toEqual([...NODE_EXTRACTOR_KEYS].sort());
    const files = read('packages/files/src/ops/files.ts');
    const at = files.indexOf('export const BYTE_DERIVED_DATA_KEYS = [');
    const bytes = [...files.slice(at, files.indexOf('] as const', at)).matchAll(/'([^']+)'/g)].map(
      (m) => m[1]!,
    );
    expect(bytes).toHaveLength(14);
    for (const k of [...copy, ...bytes]) expect(NODE_DERIVED_KEYS, k).toContain(k);
  });

  it('the extractor writes no key into nodes.data that is not derived or named as a user’s', () => {
    const dir = 'server/api/src/agent/extract';
    const files = [
      ...readdirSync(join(ROOT, dir))
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .map((f) => `${dir}/${f}`),
      'server/api/src/agent/extractor.ts',
      'server/api/src/agent/extract-heads-park.ts',
    ];
    const seen = new Set<string>();
    for (const f of files) for (const k of dataKeysBuilt(read(f))) seen.add(k);
    // The scan reads real writes (images.ts names text, vision_model, ocr).
    expect([...seen]).toEqual(expect.arrayContaining(['text', 'vision_model', 'ocr']));
    const stray = [...seen].filter(
      (k) => !NODE_DERIVED_KEYS.includes(k) && !Object.hasOwn(EXTRACTOR_USER_KEYS, k),
    );
    expect(stray).toEqual([]);
  });

  it('no key is both derived and a presentation key', () => {
    for (const k of NODE_PRESENTATION_KEYS) expect(NODE_DERIVED_KEYS).not.toContain(k);
  });
});

/** The product source files under `dirs` (no tests, no build output). */
function productFiles(dirs: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (['node_modules', '.next', 'dist', '.turbo'].includes(e.name)) continue;
      const p = join(abs, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts|mjs)$/.test(e.name) && !/\.test\.|\.d\.ts$/.test(e.name))
        out.push(relative(ROOT, p));
    }
  };
  for (const d of dirs) walk(join(ROOT, d));
  return out;
}

describe('the work stamp keys (A10 #7 fix round 2): set via markContentChanged only', () => {
  const files = productFiles(['packages', 'server', 'scripts']);
  const spelled = (key: string) => new RegExp(`['"\`]${key}['"\`]`);

  it('are no derived key: the user’s own write sets them', () => {
    for (const k of Object.keys(GATEWAY_KEY_WRITERS)) expect(NODE_DERIVED_KEYS).not.toContain(k);
  });

  it('are spelled in their gateway module and in no other product file', () => {
    expect(files.length).toBeGreaterThan(500);
    for (const [key, { module }] of Object.entries(GATEWAY_KEY_WRITERS)) {
      const hits = files.filter((f) => spelled(key).test(read(f)));
      expect(hits, key).toEqual([module]);
    }
  });

  it('are set only by markContentChanged: stampIndexWork is called in content-changed.ts alone and not exported', () => {
    const callers = files.filter((f) => /\bstampIndexWork\s*\(/.test(read(f)));
    expect(callers.sort()).toEqual([
      'packages/db/src/content-changed.ts',
      'packages/db/src/index-work.ts',
    ]);
    expect(read('packages/db/src/index-work.ts')).toMatch(/export function stampIndexWork\(/);
    expect(read('packages/db/src/index.ts')).not.toContain('stampIndexWork');
  });
});

describe('the edit check triggers from the matrix (editCheckTriggers)', () => {
  const row = (t: string) => ACCESS_MATRIX.find((x) => x.table === t)!;
  const nodeCols = [
    ...NODE_EDIT_COLUMNS,
    'id',
    'owner_id',
    'embedding',
    'salience_x',
    'created_at',
    'derived_mixed',
  ];

  it('nodes: every column not an edit column is the brain’s (deny by default); an embedding only cleared; the keys', () => {
    const tr = editCheckTriggers(row('public.nodes'), nodeCols, new Set(['embedding']));
    expect(tr.map((t) => t.name).sort()).toEqual([
      'mantle_edit_check_cols_system',
      'mantle_edit_check_ins_keys',
      'mantle_edit_check_keys',
    ]);
    // A new node's brain-only values (fix round 1, M1): dropped when on.
    const ins = tr.find((t) => t.name === 'mantle_edit_check_ins_keys')!.ddl;
    expect(ins).toContain('BEFORE INSERT ON "public"."nodes"');
    expect(ins).toContain(
      `?| "public"."mantle_node_derived_keys"() OR NEW."embedding" IS NOT NULL`,
    );
    expect(ins).toContain(`'edit', 'self', '', 'strip:embedding')`);
    const sys = tr.find((t) => t.name === 'mantle_edit_check_cols_system')!.ddl;
    // A column the matrix does not name is in 'rest': refused.
    expect(sys).toContain('"salience_x"');
    expect(sys).toContain('"derived_mixed"');
    expect(sys).not.toContain('"title"');
    // The embedding: only a change to a value, compared as text (a
    // restore's empty search_path has no vector = vector).
    expect(sys).toContain(
      '(NEW."embedding" IS NOT NULL AND OLD."embedding"::text IS DISTINCT FROM NEW."embedding"::text)',
    );
    expect(sys).toContain("WHEN (current_user = 'mantle_write_user' AND");
    expect(sys).toContain(`"mantle_edit_check_trg"('system', 'self', '', '')`);
  });

  it('apps: the code needs manage (D4), the switches admin (D5), lowering to team nothing', () => {
    const cols = [
      'node_id',
      ...APP_CODE_COLUMNS,
      ...APP_SWITCH_COLUMNS,
      'created_at',
      'updated_at',
    ];
    const tr = editCheckTriggers(row('public.apps'), cols);
    const by = new Map(tr.map((t) => [t.name, t.ddl]));
    expect([...by.keys()].sort()).toEqual([
      'mantle_edit_check_cols_admin',
      'mantle_edit_check_cols_manage',
      'mantle_edit_check_ins_admin',
      'mantle_edit_check_manage',
    ]);
    expect(by.get('mantle_edit_check_manage')).toContain('BEFORE INSERT OR DELETE');
    expect(by.get('mantle_edit_check_cols_admin')).toContain(
      `(NEW."author_level" IS DISTINCT FROM 'team' AND OLD."author_level" IS DISTINCT FROM NEW."author_level")`,
    );
    expect(by.get('mantle_edit_check_ins_admin')).toContain(
      `NEW."mcp_access" IS DISTINCT FROM false`,
    );
    for (const c of APP_CODE_COLUMNS)
      expect(by.get('mantle_edit_check_cols_manage')).toContain(`"${c}"`);
  });

  it('pages, drawings and tables: only a delete asks more (manage); an insert or update fires nothing', () => {
    for (const t of ['public.pages', 'public.draws', 'public.tables']) {
      const tr = editCheckTriggers(row(t), ['node_id', 'doc', 'scene', 'data']);
      expect(
        tr.map((x) => x.name),
        t,
      ).toEqual(['mantle_edit_check_manage']);
      expect(tr[0]!.ddl, t).toContain('BEFORE DELETE ON');
    }
  });

  it('a Recall card follows its map; a contact share needs an Admin user', () => {
    const card = editCheckTriggers(row('public.recall_nodes'), ['id', 'map_id', 'body_md']);
    expect(card[0]!.ddl).toContain(`"mantle_edit_check_trg"('edit', 'map_id', 'recall_maps', '')`);
    const share = editCheckTriggers(row('public.shares'), ['id', 'node_id', 'revoked_at', 'token']);
    for (const t of share) expect(t.ddl, t.name).toContain(`'node_id', '', 'contact')`);
    expect(share.find((t) => t.name === 'mantle_edit_check_cols_link_close')!.ddl).toContain(
      'UPDATE OF "revoked_at"',
    );
  });

  it('refuses what it cannot make: an unknown column, the reserved name, a table that is no write table', () => {
    expect(() => editCheckTriggers(row('public.apps'), ['node_id'])).toThrow(/no column/);
    const bad: TableAccess = {
      table: 'public.x',
      user: 'all',
      writer: 'content',
      editCheck: { item: 'node_id', columns: { manage: ['a b'] } },
    };
    expect(() => editCheckTriggers(bad, ['node_id', 'a b'])).toThrow(/not a column name/);
    expect(editCheckTriggers({ ...bad, writer: 'admin' }, ['node_id'])).toEqual([]);
    for (const t of ACCESS_MATRIX.filter(writeRoleWrites)) {
      for (const tr of t.editCheck
        ? editCheckTriggers(t, [
            'node_id',
            'app_node_id',
            'map_id',
            'data',
            'revoked_at',
            ...NODE_EDIT_COLUMNS,
            ...APP_CODE_COLUMNS,
            ...APP_SWITCH_COLUMNS,
            'embedding',
          ])
        : []) {
        expect(EDIT_CHECK_MIGRATION_TRIGGERS).not.toContain(tr.name);
        expect(tr.name).toMatch(/^mantle_edit_check_[a-z_]+$/);
      }
    }
  });
});
