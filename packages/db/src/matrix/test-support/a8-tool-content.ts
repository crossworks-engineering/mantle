/**
 * The content a tool cell's item holds (workspaces arch plan v3.2, S11a):
 * the A8 grid's items (a8-grid.ts makeA8Item) are bare, a title
 * and a passage, so an allowed call of a tool that works on what is inside
 * an item (a page's blocks, a table's rows, columns, tabs and snapshots, a
 * file's bytes, a Files folder, an app's open data or snapshot) had nothing
 * to work on and was counted, not run. Here each such tool names what it
 * needs and seeds it, as the superuser in the scratch test database, on a
 * fresh item of the cell's kind and placement (made by makeA8Item, so its
 * grants are the grid's), and hands back the arguments that name it.
 *
 * Every cell of such a tool, allowed or refused, gets its own seeded item,
 * so a refusal is a refusal of real content and no cell sees another's
 * edit. The content is the least each tool's own code reads (the comments
 * name the reader); nothing here decides an answer. What the tools package
 * owns (the workbook file a table is, an app package) is written through
 * the hooks the test hands in (A8ContentDeps), so @mantle/db imports
 * nothing above it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type postgres from 'postgres';
import { ITEM_KINDS } from '@mantle/client-types/kinds';
import type { GuidePlacement } from '../guide-oracle';
import { FIXTURE_ACTOR, makeA8Item, type A8Fixture, type A8Item } from './a8-grid';

type Sql = postgres.Sql;

/** What the test hands in: the files root, and the writers of what the
 *  tools' own packages own. */
export type A8ContentDeps = {
  /** MANTLE_FILES_ROOT: a file's bytes sit at its path under it. */
  filesRoot: string;
  /** Write a table's workbook file (@mantle/tabledb writeDocFile) at the
   *  storage path `rel`; its size, stats and shape. */
  writeWorkbook: (
    rel: string,
    workbook: unknown,
    meta: { nodeId: string; ownerId: string },
  ) => { sizeBytes: number; stats: unknown; shapeHash: string };
  /** Copy a workbook file to a snapshot's storage path; its size. */
  snapshotWorkbook: (rel: string, snapshotRel: string) => number;
  /** A table storage path (relative to TABLE_DB_DIR) as a file path. */
  tableFile: (rel: string) => string;
  /** The workbook engine's version (tables.engine_version). */
  engineVersion: number;
  /** Write the app's package (@mantle/content writeAppPackage, as system,
   *  no data) to `dest`. */
  writeAppPackage: (appId: string, dest: string) => Promise<void>;
  /** Where the app's own database file goes (under APP_DB_DIR). */
  appDbFile: (appId: string) => string;
  /** Make the app's own database with its declared schema and a row
   *  (@mantle/content appDbSeedRows, as system). */
  seedAppDb: (appId: string, schema: { schemaSql: string; schemaVersion: number }) => Promise<void>;
};

/** A seeded cell's item and the arguments beside the item's own. */
export type A8Seeded = { item: A8Item; input: Record<string, unknown> };

type Seed = (s: {
  sql: Sql;
  fx: A8Fixture;
  deps: A8ContentDeps;
  item: A8Item;
  kind: string;
  placement: GuidePlacement;
}) => Promise<Record<string, unknown>>;

/** A content write as the superuser: the fixture's actor, the item's head
 *  locked, and the row triggers off (a snapshot copy's content is read-only
 *  to every writer but its maker, and the fixture is its maker here). */
async function asFixture(sql: Sql, id: string, fn: (tx: postgres.TransactionSql) => Promise<void>) {
  await sql.begin(async (tx) => {
    await tx.unsafe(FIXTURE_ACTOR);
    await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
    await tx.unsafe(`set local session_replication_role = replica`);
    await fn(tx);
  });
}

// ── pages ───────────────────────────────────────────────────────────────────

/** A page with one h1 and one paragraph, its draft the same doc (TipTap
 *  JSON; blocks found by attrs.id: content block-edit.ts, page-split.ts). */
const PAGE_DOC = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { id: 'blk-h1', level: 1 },
      content: [{ type: 'text', text: 'Section one' }],
    },
    {
      type: 'paragraph',
      attrs: { id: 'blk-p1' },
      content: [{ type: 'text', text: 'Body text.' }],
    },
  ],
};

const seedPage: Seed = async ({ sql, item }) => {
  await asFixture(sql, item.id, async (tx) => {
    await tx`update pages set doc = ${tx.json(PAGE_DOC)}, draft_doc = ${tx.json(PAGE_DOC)}
             where node_id = ${item.id}`;
  });
  return {};
};
const page =
  (input: (s: Parameters<Seed>[0]) => Record<string, unknown> | Promise<Record<string, unknown>>) =>
  async (s: Parameters<Seed>[0]) => ({ ...(await seedPage(s)), ...(await input(s)) });

// ── tables ──────────────────────────────────────────────────────────────────

/** A workbook of two tabs (a tab is the file's: tabledb engine.ts), a text
 *  key column, a row to read and edit, one to delete, a column to delete. */
const WORKBOOK = {
  tabs: [
    {
      id: 'tmain',
      name: 'Main',
      aggregates: {},
      views: [],
      columns: [
        { id: 'ckey', name: 'Key', type: 'text' },
        { id: 'cnote', name: 'Note', type: 'text' },
        { id: 'cqty', name: 'Qty', type: 'number' },
        { id: 'cdel', name: 'Extra', type: 'text' },
      ],
      rows: [
        { id: 'r1', cells: { ckey: 'k1', cnote: 'n', cqty: 1 } },
        { id: 'r2', cells: { ckey: 'k2', cqty: 2 } },
      ],
    },
    {
      id: 'tother',
      name: 'Other',
      aggregates: {},
      views: [],
      columns: [{ id: 'cname', name: 'Name', type: 'text' }],
      rows: [{ id: 'o1', cells: { cname: 'x' } }],
    },
  ],
};

/** The table's storage is its workbook file (tables.storage_path), its
 *  JSON data empty (content tables/shared.ts docsOf). */
async function seedTable(s: Parameters<Seed>[0]): Promise<string> {
  const { sql, fx, deps, item } = s;
  const rel = `${fx.owner}/${item.id}.sqlite`;
  const w = deps.writeWorkbook(rel, WORKBOOK, { nodeId: item.id, ownerId: fx.owner });
  await asFixture(sql, item.id, async (tx) => {
    await tx`update tables set data = '{}'::jsonb, draft_data = null, storage_path = ${rel},
               size_bytes = ${w.sizeBytes}, stats = ${tx.json(w.stats as never)},
               shape_hash = ${w.shapeHash}, engine_version = ${deps.engineVersion}
             where node_id = ${item.id}`;
  });
  return rel;
}
/** A draft of the table: a copy of its workbook file as the draft's
 *  revision (tables.draft_path: content tables/draft.ts commitTable
 *  publishes it). */
async function seedTableDraft(s: Parameters<Seed>[0]): Promise<void> {
  const { sql, fx, deps, item } = s;
  const rel = await seedTable(s);
  const draftRel = `${fx.owner}/${item.id}.draft-a8.sqlite`;
  deps.snapshotWorkbook(rel, draftRel);
  await asFixture(sql, item.id, async (tx) => {
    await tx`update tables set draft_path = ${draftRel}, draft_data = '{}'::jsonb,
               draft_updated_at = now()
             where node_id = ${item.id}`;
  });
}

const table =
  (input: Record<string, unknown>) =>
  async (s: Parameters<Seed>[0]): Promise<Record<string, unknown>> => {
    await seedTable(s);
    return input;
  };

/** A snapshot of the item (node_snapshots: content table-snapshots.ts,
 *  app-snapshots.ts), its id. */
async function seedSnapshot(
  s: Parameters<Seed>[0],
  kind: 'table' | 'app',
  rel?: string,
): Promise<string> {
  const { sql, fx, deps, item } = s;
  const id = randomUUID();
  const srel = rel ? `_snapshots/${fx.owner}/${item.id}/${id}.sqlite` : null;
  const bytes = rel && srel ? deps.snapshotWorkbook(rel, srel) : null;
  const code =
    kind === 'app'
      ? {
          source: { entry: 'App.tsx', files: { 'App.tsx': APP_SOURCE } },
          draft: null,
          manifest: {},
          publishedBuild: null,
        }
      : null;
  await asFixture(sql, item.id, async (tx) => {
    await tx`insert into node_snapshots
               (id, owner_id, node_id, node_kind, seq, trigger, actor, code, db_path, db_bytes,
                schema_version)
             values (${id}, ${fx.owner}, ${item.id}, ${kind}, 1, 'manual', 'owner',
                     ${code ? tx.json(code) : null}, ${srel}, ${bytes}, ${srel ? 1 : null})`;
  });
  return id;
}

// ── apps ────────────────────────────────────────────────────────────────────

const APP_SOURCE = 'export default function App() { return null; }';

/** An app that builds (its source an entry the build finds), its data open
 *  to MCP (apps.mcp_access and a good published build: content
 *  mcp-app-data.ts memberWhere). */
async function seedApp(s: Parameters<Seed>[0], open = false): Promise<void> {
  const { sql, item } = s;
  const source = { entry: 'App.tsx', files: { 'App.tsx': APP_SOURCE } };
  const build = {
    storageKey: 'apps/a8.js',
    sha256: 'a8',
    builtAt: '2026-10-01T00:00:00Z',
    esbuildVersion: '0',
    bytes: 1,
    ok: true,
  };
  await asFixture(sql, item.id, async (tx) => {
    await tx`update apps set source = ${tx.json(source)}, manifest = '{}'::jsonb
             where node_id = ${item.id}`;
    if (open) {
      await tx`update apps set mcp_access = true, published_build = ${tx.json(build)}
               where node_id = ${item.id}`;
    }
  });
}

/** The app's own database: its manifest declares one table (a8), made with
 *  a row (content app-broker.ts: a seed's table must exist; an export reads
 *  it). */
const APP_DB = { schemaSql: 'create table if not exists a8 (v integer)', schemaVersion: 1 };
async function seedAppWithDb(s: Parameters<Seed>[0]): Promise<void> {
  const { sql, deps, item } = s;
  await seedApp(s);
  // The grid's app names a database file outside the test's directory: this
  // one's goes under APP_DB_DIR, as the product makes it.
  await asFixture(sql, item.id, async (tx) => {
    await tx`update apps set manifest = ${tx.json({ sqlite: APP_DB })} where node_id = ${item.id}`;
    await tx`update app_databases set storage_path = ${deps.appDbFile(item.id)}, schema_version = 0
             where app_node_id = ${item.id}`;
  });
  await deps.seedAppDb(item.id, APP_DB);
}

// ── files ───────────────────────────────────────────────────────────────────

/** A 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const CSV = 'name,qty\napple,3\npear,5\n';

type FileFlavour = 'csv' | 'png' | 'mantleapp';
const MIME: Record<FileFlavour, string> = {
  csv: 'text/csv; charset=utf-8',
  png: 'image/png',
  mantleapp: 'application/zip',
};

/** The disk directory of a Files path (files paths.ts: the labels after
 *  `files`, `_` as `-`). */
const diskDir = (root: string, ltree: string) =>
  path.join(
    root,
    ...ltree
      .split('.')
      .slice(1)
      .map((l) => l.replace(/_/g, '-')),
  );

/** A file's bytes on disk and its row's data (files ops/shared.ts
 *  fileRowFromNode: a file is found by its filename and path). */
async function seedFile(s: Parameters<Seed>[0], flavour: FileFlavour): Promise<void> {
  const { sql, fx, deps, item } = s;
  const filename = `${fx.tag}-${item.id.slice(0, 8)}.${flavour}`;
  const dest = path.join(diskDir(deps.filesRoot, item.parentPath), filename);
  mkdirSync(path.dirname(dest), { recursive: true });
  let bytes: Buffer;
  if (flavour === 'mantleapp') {
    const app = await makeA8Item(sql, fx, 'app', 'admin');
    await seedApp({ ...s, item: app, kind: 'app' });
    await deps.writeAppPackage(app.id, dest);
    const { readFileSync } = await import('node:fs');
    bytes = readFileSync(dest);
  } else {
    bytes = flavour === 'png' ? PNG : Buffer.from(CSV);
    writeFileSync(dest, bytes);
  }
  const data = {
    filename,
    extension: flavour,
    mime_type: MIME[flavour],
    size_bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(flavour === 'csv' ? { content: CSV } : {}),
  };
  await asFixture(sql, item.id, async (tx) => {
    await tx`update nodes set data = data || ${tx.json(data)} where id = ${item.id}`;
  });
}
const file =
  (flavour: FileFlavour, input: Record<string, unknown> = {}) =>
  async (s: Parameters<Seed>[0]): Promise<Record<string, unknown>> => {
    await seedFile(s, flavour);
    return input;
  };

/** A second item of the kind beside the cell's, the caller reads it as it
 *  reads the cell's (a snapshot copy's sibling at the root). */
const beside = (s: Parameters<Seed>[0], kind = s.kind) =>
  makeA8Item(s.sql, s.fx, kind, s.placement === 'snapshot' ? 'root' : s.placement);

/** A Files folder the fixture's member workspaces may make files in: the
 *  copy tools' destination (homed in H, Write on for W, R, T and O, the
 *  members' private workspaces). Made once. */
export async function makeA8DropFolder(sql: Sql, fx: A8Fixture): Promise<string> {
  const p = `files.${fx.tag}drop`;
  const id = randomUUID();
  await sql.begin(async (tx) => {
    await tx.unsafe(FIXTURE_ACTOR);
    await tx`select mantle_lock_heads(array[${fx.kindRoot.file!}]::uuid[], 'share')`;
    await tx`insert into nodes (id, owner_id, type, title, path)
             values (${id}, ${fx.owner}, 'branch', ${`${fx.tag} drop`}, ${p}::ltree)`;
  });
  const writers = [
    fx.ws.W,
    fx.ws.R,
    fx.ws.T,
    fx.ws.O,
    ...Object.values(fx.privateWs).filter((w): w is string => !!w),
  ];
  await sql.begin(async (tx) => {
    await tx.unsafe(FIXTURE_ACTOR);
    await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
    await tx`delete from item_grants where node_id = ${id} and via_folder_id is null`;
    await tx`insert into item_grants (node_id, workspace_id, is_home, write)
             values (${id}, ${fx.ws.H}, true, false)`;
    for (const w of writers) {
      await tx`insert into item_grants (node_id, workspace_id, is_home, write)
               values (${id}, ${w}, false, true)`;
    }
  });
  return p;
}

/** The Files folders of the fixture: a branch item made under the files
 *  root (its folder F the file kind's), not the notes tree. */
const filesBranch = (sql: Sql, fx: A8Fixture, placement: GuidePlacement) =>
  makeA8Item(
    sql,
    {
      ...fx,
      kindRoot: { ...fx.kindRoot, branch: fx.kindRoot.file! },
      kindRootPath: { ...fx.kindRootPath, branch: fx.kindRootPath.file! },
      folders: { ...fx.folders, branch: fx.folders.file! },
    },
    'branch',
    placement,
  );

const fresh = (fx: A8Fixture) => `${fx.tag}-${randomUUID().slice(0, 6)}`;

/** The move tools' destination: a folder at a kind's tree root homed in T,
 *  no other grant (the guide's move, H to T: Moderator of H and of T). Made
 *  once per tree root. */
const targets = new Map<string, { id: string; path: string }>();
export async function a8MoveTarget(
  sql: Sql,
  fx: A8Fixture,
  kind: string,
): Promise<{ id: string; path: string }> {
  const rootKind = kind === 'branch' ? 'file' : kind;
  const root = fx.kindRootPath[rootKind]!;
  const key = `${fx.tag} ${root}`;
  const have = targets.get(key);
  if (have) return have;
  const id = randomUUID();
  const p = `${root}.${fx.tag}t`;
  await sql.begin(async (tx) => {
    await tx.unsafe(FIXTURE_ACTOR);
    await tx`select mantle_lock_heads(array[${fx.kindRoot[rootKind]!}]::uuid[], 'share')`;
    await tx`insert into nodes (id, owner_id, type, title, path)
             values (${id}, ${fx.owner}, 'branch', ${`${fx.tag} T ${rootKind}`}, ${p}::ltree)`;
  });
  await sql.begin(async (tx) => {
    await tx.unsafe(FIXTURE_ACTOR);
    await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
    await tx`delete from item_grants where node_id = ${id} and via_folder_id is null`;
    await tx`insert into item_grants (node_id, workspace_id, is_home, write)
             values (${id}, ${fx.ws.T}, true, false)`;
  });
  const t = { id, path: p };
  targets.set(key, t);
  return t;
}

/** A kind's tree name (tree_item_move's `kind`). */
const treeKindOf = (kind: string) =>
  (ITEM_KINDS as Record<string, { tree: { kind: string } | null }>)[kind]?.tree?.kind ?? kind;

/** Each tool whose cells need content: what (the not-run reason it had)
 *  and its seed. `filesBranch`: its item is a Files folder. */
export const A8_TOOL_CONTENT: Readonly<
  Record<string, { needs: string; seed: Seed; filesBranch?: true }>
> = {
  page_block_get: { needs: 'a block of the page', seed: page(() => ({ block_id: 'blk-p1' })) },
  page_block_update: {
    needs: 'a block of the page',
    seed: page(() => ({ block_id: 'blk-p1', markdown: 'a8 updated' })),
  },
  page_block_insert_after: {
    needs: 'a block of the page',
    seed: page(() => ({ after_block_id: 'blk-p1', markdown: 'a8 new' })),
  },
  page_block_insert_before: {
    needs: 'a block of the page',
    seed: page(() => ({ before_block_id: 'blk-p1', markdown: 'a8 new' })),
  },
  page_block_delete: { needs: 'a block of the page', seed: page(() => ({ block_id: 'blk-p1' })) },
  page_blocks_apply: {
    needs: 'a block of the page',
    seed: page(() => ({ ops: [{ op: 'update', block_id: 'blk-p1', markdown: 'a8 applied' }] })),
  },
  page_split: { needs: 'a heading of the page', seed: page(() => ({ by: 'h1' })) },
  page_extract_section: {
    needs: 'a heading block of the page',
    seed: page(() => ({ heading_block_id: 'blk-h1' })),
  },
  page_commit: { needs: 'a draft of the page', seed: page(() => ({})) },
  // A page may mention itself (content pages/structure.ts: any node the
  // caller reads).
  page_mention: {
    needs: 'a mention target the caller reads',
    seed: page((s) => ({ target_id: s.item.id })),
  },
  content_supersede: {
    needs: 'a replacement the caller reads',
    seed: async (s) => ({ superseded_by: (await beside(s)).id, reason: 'corrected' }),
  },
  page_replace_from_file: {
    needs: 'the bytes of a file (the fixture’s files have none)',
    seed: page(async (s) => {
      const f = await beside(s, 'file');
      await seedFile({ ...s, item: f, kind: 'file' }, 'csv');
      return { file_id: f.id };
    }),
  },
  table_snapshot_restore: {
    needs: 'a snapshot of the table',
    seed: async (s) => ({
      snapshot_id: await seedSnapshot(s, 'table', await seedTable(s)),
      discard_draft: true,
    }),
  },
  table_snapshot_delete: {
    needs: 'a snapshot of the table',
    seed: async (s) => ({ snapshot_id: await seedSnapshot(s, 'table', await seedTable(s)) }),
  },
  table_sql: {
    needs: 'the SQL storage of the table',
    seed: table({ sql: 'SELECT "Key" FROM "Main"' }),
  },
  table_aggregate: { needs: 'the SQL storage of the table', seed: table({ group_by: ['Key'] }) },
  table_row_get: { needs: 'a row of the table', seed: table({ row_id: 'r1' }) },
  table_row_update: {
    needs: 'a row of the table',
    seed: table({ row_id: 'r1', cells: { Note: 'a8' } }),
  },
  table_row_delete: { needs: 'a row of the table', seed: table({ row_id: 'r2' }) },
  table_cell_set: {
    needs: 'a row of the table',
    seed: table({ row_id: 'r1', column: 'cqty', value: 5 }),
  },
  table_rows_upsert: {
    needs: 'a key column of the table',
    seed: table({ key: ['Key'], rows: [{ Key: 'k1', Note: 'a8' }] }),
  },
  table_column_update: {
    needs: 'a column of the table',
    seed: table({ column: 'cnote', name: 'Note2' }),
  },
  table_column_delete: { needs: 'a column of the table', seed: table({ column: 'cdel' }) },
  table_set_aggregate: {
    needs: 'a column of the table',
    seed: table({ column: 'cqty', kind: 'count' }),
  },
  table_tab_rename: {
    needs: 'a second tab of the table',
    seed: table({ tab: 'tother', name: 'Renamed' }),
  },
  table_tab_delete: { needs: 'a second tab of the table', seed: table({ tab: 'tother' }) },
  // A formula with one input and one expression (content-core
  // formula-eval.ts: an input's value is its default).
  formula_evaluate: {
    needs: 'a target of the formula',
    seed: async ({ sql, item }) => {
      await asFixture(sql, item.id, async (tx) => {
        await tx`update nodes set data = jsonb_set(jsonb_set(data, '{spec,variables}',
                   ${tx.json([{ symbol: 'a', role: 'input', value: 2 }])}),
                   '{spec,expressions}', ${tx.json([{ id: 'x', expression: '{a} * 2' }])})
                 where id = ${item.id}`;
      });
      return { target: 'x' };
    },
  },
  // content recall-native.ts confirmRecallPrompt: a card's use-when line.
  recall_prompt_confirm: {
    needs: 'a card with a use-when line',
    seed: async ({ sql, item }) => {
      await asFixture(sql, item.id, async (tx) => {
        await tx`update recall_nodes set use_when = 'When an A8 cell asks'
                 where map_id = ${item.id} and slug = 'card'`;
      });
      return {};
    },
  },
  app_data_schema: {
    needs: 'an app with its data open to MCP and a team member',
    seed: async (s) => (await seedApp(s, true), {}),
  },
  app_data_query: {
    needs: 'an app with its data open to MCP and a team member',
    seed: async (s) => (await seedApp(s, true), { sql: 'select 1' }),
  },
  app_data_write: {
    needs: 'an app with its data open to MCP and a team member',
    seed: async (s) => (await seedApp(s, true), { sql: 'insert into a8 (v) values (1)' }),
  },
  app_snapshot_restore: {
    needs: 'a snapshot of the app',
    seed: async (s) => (
      await seedApp(s),
      { snapshot_id: await seedSnapshot(s, 'app'), mode: 'code' }
    ),
  },
  app_snapshot_delete: {
    needs: 'a snapshot of the app',
    seed: async (s) => (await seedApp(s), { snapshot_id: await seedSnapshot(s, 'app') }),
  },
  // An app table export links a brain Table (app_table_exports).
  app_table_export_remove: {
    needs: 'a table export of the app',
    seed: async (s) => {
      const t = await makeA8Item(s.sql, s.fx, 'table', 'admin');
      await asFixture(s.sql, s.item.id, async (tx) => {
        await tx`insert into app_table_exports (owner_id, app_node_id, sqlite_table, table_node_id)
                 values (${s.fx.owner}, ${s.item.id}, 'a8', ${t.id})`;
      });
      return { table: 'a8' };
    },
  },
  app_build: { needs: 'the app runtime manifest', seed: async (s) => (await seedApp(s), {}) },
  app_export: {
    needs: 'the Files root folder in the caller’s scope',
    seed: async (s) => (await seedApp(s), { with_data: false }),
  },
  file_read: { needs: 'the bytes of a file (the fixture’s files have none)', seed: file('csv') },
  file_copy: {
    needs: 'the bytes of a file (the fixture’s files have none)',
    seed: async (s) => (
      await seedFile(s, 'csv'),
      { dest_path: `files.${s.fx.tag}drop`, new_filename: `${fresh(s.fx)}.csv` }
    ),
  },
  file_rename: {
    needs: 'the bytes of a file (the fixture’s files have none)',
    seed: async (s) => (await seedFile(s, 'csv'), { new_stem: fresh(s.fx) }),
  },
  show_image: { needs: 'the bytes of a file (the fixture’s files have none)', seed: file('png') },
  note_from_file: {
    needs: 'the bytes of a file (the fixture’s files have none)',
    seed: file('csv'),
  },
  page_from_file: {
    needs: 'the bytes of a file (the fixture’s files have none)',
    seed: file('csv', { supersede_source: false }),
  },
  table_from_file: {
    needs: 'the bytes of a file (the fixture’s files have none)',
    seed: file('csv'),
  },
  app_import: {
    needs: 'the bytes of a file (the fixture’s files have none)',
    seed: file('mantleapp'),
  },
  folder_rename: {
    needs: 'a Files folder (the fixture’s folders are in the notes tree)',
    filesBranch: true,
    seed: async (s) => ({ new_name: fresh(s.fx) }),
  },
  folder_describe: {
    needs: 'a Files folder (the fixture’s folders are in the notes tree)',
    filesBranch: true,
    seed: async () => ({ description: 'a8' }),
  },
  folder_delete: {
    needs: 'a Files folder (the fixture’s folders are in the notes tree)',
    filesBranch: true,
    seed: async () => ({}),
  },
  folder_set_indexing: {
    needs: 'a Files folder (the fixture’s folders are in the notes tree)',
    filesBranch: true,
    seed: async () => ({ mode: 'metadata' }),
  },
  folder_copy: {
    needs: 'a Files folder (the fixture’s folders are in the notes tree)',
    filesBranch: true,
    seed: async (s) => ({ dest_parent_path: `files.${s.fx.tag}drop` }),
  },
  table_commit: { needs: 'a draft of the table', seed: async (s) => (await seedTableDraft(s), {}) },
  table_snapshot_create: { needs: 'a committed workbook of the table', seed: table({}) },
  app_db_seed: {
    needs: 'the app’s own database with the a8 table',
    seed: async (s) => (await seedAppWithDb(s), {}),
  },
  app_table_export_set: {
    needs: 'the app’s own database with the a8 table',
    seed: async (s) => (await seedAppWithDb(s), { table: 'a8' }),
  },
  // Its export is a file named after the item: a fresh item each cell, so
  // no export finds the one before it.
  export_node: { needs: 'an item no export was made of', seed: async () => ({}) },
  // The moves: the item to a folder homed in T (a8MoveTarget).
  file_move: {
    needs: 'the bytes of a file and a folder homed in T',
    seed: async (s) => (
      await seedFile(s, 'csv'),
      { dest_path: (await a8MoveTarget(s.sql, s.fx, 'file')).path }
    ),
  },
  folder_move: {
    needs: 'a Files folder and a folder homed in T',
    filesBranch: true,
    seed: async (s) => ({ dest_parent_path: (await a8MoveTarget(s.sql, s.fx, 'file')).path }),
  },
  tree_item_move: {
    needs: 'a folder homed in T',
    seed: async (s) => {
      if (s.kind === 'file') await seedFile(s, 'csv');
      return {
        kind: treeKindOf(s.kind),
        folder_id: (await a8MoveTarget(s.sql, s.fx, s.kind)).id,
      };
    },
  },
  page_move: {
    needs: 'a folder homed in T',
    seed: async (s) => ({ folder_id: (await a8MoveTarget(s.sql, s.fx, 'page')).id }),
  },
  // The sandbox tools read a file or a Files folder in the caller's scope.
  sandbox_import: { needs: 'the bytes of a file', seed: file('csv') },
  sandbox_create: {
    needs: 'a Files folder (the inbox)',
    filesBranch: true,
    seed: async () => ({ name: `a8-${randomUUID().slice(0, 8)}` }),
  },
};

/** The bytes of a file (and a SQLite file's write-ahead log), hashed; 'none'
 *  when there is none. */
function fileHash(abs: string | null): string {
  if (!abs || !existsSync(abs)) return 'none';
  const h = createHash('sha256').update(readFileSync(abs));
  if (existsSync(`${abs}-wal`)) h.update(readFileSync(`${abs}-wal`));
  return h.digest('hex').slice(0, 16);
}

/**
 * What a seeded item holds beyond the grid's probe (a8_probe reads the node,
 * its content row's doc and draft, its cards, links and app data): the
 * node's row, its table's and app's rows, its snapshots, its app's table
 * exports and its cards whole; and what is on disk: the table's workbook
 * file and its draft's, and a file's bytes. Read as the superuser; a
 * refused write must change none of it (a write that changes a file before
 * it is refused is caught too).
 */
export async function a8ContentProbe(sql: Sql, id: string, deps: A8ContentDeps): Promise<string> {
  const [disk] = await sql<
    { storage: string | null; draft: string | null; filename: string | null; path: string }[]
  >`select t.storage_path as storage, t.draft_path as draft,
           case when n.type = 'file' then n.data->>'filename' end as filename,
           n.path::text as path
      from nodes n left join tables t on t.node_id = n.id
     where n.id = ${id}`;
  const onDisk = disk
    ? [
        fileHash(disk.storage ? deps.tableFile(disk.storage) : null),
        fileHash(disk.draft ? deps.tableFile(disk.draft) : null),
        // A file sits at its folder's path (its node's path), on disk under
        // that folder's directory.
        fileHash(
          disk.filename ? path.join(diskDir(deps.filesRoot, disk.path), disk.filename) : null,
        ),
      ].join(',')
    : '';
  const [r] = await sql<{ p: string }[]>`
    select concat_ws('|', ${onDisk}::text,
      (select (to_jsonb(n) - 'updated_at')::text from nodes n where n.id = ${id}),
      (select (to_jsonb(t) - 'updated_at' - 'draft_updated_at')::text
         from tables t where t.node_id = ${id}),
      (select (to_jsonb(a) - 'updated_at')::text from apps a where a.node_id = ${id}),
      (select string_agg(s.id::text, ',' order by s.id) from node_snapshots s
        where s.node_id = ${id}),
      (select string_agg(e.sqlite_table, ',' order by e.sqlite_table) from app_table_exports e
        where e.app_node_id = ${id}),
      (select string_agg((to_jsonb(c) - 'updated_at')::text, ',' order by c.slug)
         from recall_nodes c where c.map_id = ${id})) as p`;
  return r?.p ?? '';
}

/** A fresh item of the cell's kind and placement with the content its tool
 *  needs, and the arguments that name it; null for a tool that needs none. */
export async function seedA8ToolItem(
  sql: Sql,
  fx: A8Fixture,
  deps: A8ContentDeps,
  cell: { tool: string; kind: string; placement: GuidePlacement },
): Promise<A8Seeded | null> {
  const c = A8_TOOL_CONTENT[cell.tool];
  if (!c) return null;
  const item = c.filesBranch
    ? await filesBranch(sql, fx, cell.placement)
    : await makeA8Item(sql, fx, cell.kind, cell.placement);
  const input = await c.seed({ sql, fx, deps, item, kind: cell.kind, placement: cell.placement });
  return { item, input };
}
