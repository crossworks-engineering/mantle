/**
 * W7a fix round 1: the lists the Admin gate and the item edit check run on
 * stay true to the builtins they name.
 *
 *  - H1: a tool that runs WHOLE on the system pool (`systemWhole`) is an
 *    Admin-area tool that names no item: no node precondition, no item
 *    write target, no item id argument. Every other area tool runs in the
 *    caller's scope.
 *  - M2: every item write target names a real builtin and one of its
 *    arguments; every builtin that writes and declares a node precondition
 *    on an id it changes is listed (or named here as one that does not
 *    change the item it reads).
 */
import { describe, expect, it, vi } from 'vitest';

const area = vi.hoisted(() => ({ users: false, scope: true }));
vi.mock('./admin-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./admin-gate')>()),
  callerHasArea: vi.fn(async (a: string) => a === 'users' && area.users),
  callerScope: vi.fn(() => (area.scope ? { kind: 'user', loginId: 'l', ws: [], modWs: [] } : null)),
}));

import { gateLists, type GateCaller } from '@mantle/db';
// The gate's narrowers and the `tool` source (gateLists reads them).
import './gate-narrowers';
import { builtinItems } from './item-write-gate';
import { getBuiltin, listBuiltins } from './registry';
import { builtinToolGatePolicy, builtinToolRef } from './tool-gate-policy';
import { policyAdminOnly, policyArea, policySystemWhole } from './tool-policy';

// Read from each builtin's policy (A5 step 6a deleted the list views).
/** The builtins that run whole on the system pool. */
const systemWhole = () => listBuiltins().filter((d) => policySystemWhole(d.policy));
/** A builtin's Admin area, or null. */
const areaOf = (slug: string) => {
  const def = getBuiltin(slug);
  return def ? policyArea(def.policy) : null;
};
/** The builtins whose write names items, with their targets. */
const itemWrites = () =>
  listBuiltins().flatMap((d) => (d.policy.items ? [[d.slug, d.policy.items] as const] : []));

/** Writes whose node precondition names an item they only READ (a source
 *  they copy, convert, import, show or send), or a folder they create in
 *  (the database's create check). */
const READS_ITS_ITEM: ReadonlySet<string> = new Set([
  'file_copy',
  'folder_copy',
  'note_from_file',
  'note_from_page',
  'page_from_file',
  'page_from_note',
  'page_from_notes',
  'page_from_journal',
  'page_create',
  'table_from_file',
  'tree_folder_create',
  'show_image',
  'video_ingest',
  'export_node',
  'sandbox_import',
  'peer_file_copy',
  'email_page',
  'app_import',
]);

/**
 * Writes that take an item-like id but are not on the item write list, each
 * with why (W7 integration fix 2, hardening): the id names something that is
 * not an item the scope edits, a source the tool only reads, or a folder a
 * create lands in (the database's create check), or the handler checks it.
 */
const NOT_AN_ITEM_WRITE: ReadonlyMap<string, string> = new Map([
  ['app_data_write', "the app's MCP access switch and the login's Write switch, in the handler"],
  ['app_import', 'reads the file it imports; the new app is a create'],
  ['app_undelete', "a deleted app: its home's Moderators only, in the handler (app-trash)"],
  ['export_node', 'reads the item it exports; the file it saves is a create'],
  ['file_copy', 'reads the source; the copy is a create'],
  ['folder_copy', 'reads the source; the copy is a create'],
  ['generate_image', 'reads its input images; the image is a create'],
  ['invoke_agent', "hands item ids to a child turn that runs in the caller's scope"],
  ['note_from_file', 'reads the source; the note is a create'],
  ['note_from_page', 'reads the source; the note is a create'],
  ['page_create', "a create: the folder's create check is the database's"],
  ['page_from_journal', 'reads the entries; the page is a create'],
  ['peer_file_copy', "reads a linked brain's file; the copy is a create"],
  ['pending_approve', "a pending call, not an item: the caller's own (approvePendingCall)"],
  ['pending_reject', "a pending call, not an item: the caller's own (rejectPendingCall)"],
  ['run_append', 'a run, not an item: the runs scope check'],
  ['run_audit', 'a run, not an item: the runs scope check'],
  ['run_cancel', 'a run, not an item: the runs scope check'],
  ['sandbox_create', 'only the brain owner mounts a folder (the sandbox maker rule)'],
  ['sandbox_import', 'reads the file it imports into a sandbox'],
  ['show_image', 'reads the image it shows'],
  ['table_from_file', 'reads the source; the table is a create'],
  ['telegram_edit', "the anchor's Telegram chat and message ids: the anchor only"],
  ['telegram_mark_processed', "the anchor's Telegram inbox row: the anchor only"],
  ['telegram_react', "the anchor's Telegram chat and message ids: the anchor only"],
  ['telegram_send', "the anchor's Telegram chat id: allowlisted chats only"],
  ['tree_folder_create', "a create: the parent's create check is the database's"],
  ['video_ingest', 'reads the video file; the transcript is a create'],
]);

/**
 * The writes whose item pre-check went (docs/actors.md, "Pre-check
 * deletion"; server/web/server/precheck-removal.db.test.ts proves each):
 * the database refuses the same write itself, with both checks on, on the
 * write role where the pre-check ran, and its second reason is proven. Each
 * with the check that refuses it. Their `items` are gone; one listed here
 * that declares them again goes from the list.
 */
const DATABASE_CHECKED: ReadonlyMap<string, string> = new Map([
  ...(
    [
      'note_update',
      'task_update',
      'event_update',
      'formula_update',
      'contact_update',
      'journal_update',
      'page_update',
      'page_update_draft',
      'page_commit',
      'page_discard_draft',
      'page_replace_from_file',
      'page_mention',
    ] as const
  ).map((slug) => [slug, 'the write check (0278): edit of the item'] as const),
  ...(
    [
      'note_delete',
      'task_delete',
      'event_delete',
      'formula_delete',
      'contact_delete',
      'journal_delete',
      'page_delete',
    ] as const
  ).map((slug) => [slug, 'the delete check (0266): manage of the item'] as const),
  ['page_move', 'the move check (0245, 0279): manage of the item'],
  ['process_extraction', 'its precondition reads the item in the scope (row security)'],
  ['access_set', 'it writes nothing (the levels went)'],
  ['node_unshare', "the handler's own rule (closeLink), and link_close (0280)"],
  ['page_unshare', "the handler's own rule (closeLink), and link_close (0280)"],
  ['tree_folder_update', 'the write check (0278); a rename or move, mantle_subtree_rewrite (0282)'],
  ...(
    [
      'recall_card_put',
      'recall_card_delete',
      'recall_map_update',
      'recall_map_publish',
      'recall_cards_reorder',
      'recall_map_set_slug',
      'recall_card_set_slug',
      'recall_prompt_confirm',
      'recall_revision_restore',
    ] as const
  ).map((slug) => [slug, 'the Recall edit checks (0280): edit of the map'] as const),
  ['recall_map_delete', 'the delete check (0266): manage of the map'],
  ...(
    [
      'table_column_add',
      'table_column_update',
      'table_column_delete',
      'table_set_aggregate',
      'table_set_view',
      'table_row_add',
      'table_rows_add',
      'table_rows_upsert',
      'table_row_update',
      'table_row_delete',
      'table_cell_set',
      'table_tab_add',
      'table_tab_rename',
      'table_tab_delete',
      'table_commit',
      'table_snapshot_restore',
    ] as const
  ).map(
    (slug) => [slug, "the write check (0278) at the tables broker's checked statement"] as const,
  ),
  ['table_update', 'the write check (0278): edit of the item'],
  ['table_delete', 'the delete check (0266): manage of the item'],
  ['table_snapshot_create', 'the node_snapshots edit check (0280)'],
  ['table_snapshot_delete', 'the node_snapshots edit check (0280)'],
  ...(
    [
      'file_rename',
      'folder_rename',
      'folder_describe',
      'file_set_indexing',
      'folder_set_indexing',
    ] as const
  ).map(
    (slug) =>
      [slug, 'the write check (0278); a folder rename, mantle_subtree_rewrite (0282)'] as const,
  ),
  ['file_move', 'the move check (0245, 0279): manage of the item'],
  ['folder_move', 'mantle_subtree_rewrite (0282) and the move check: manage'],
  ['folder_delete', 'the delete check (0266) after the hidden-rows rule (0282)'],
  ...(['app_file_write', 'app_file_delete', 'app_source_set', 'app_tools_set'] as const).map(
    (slug) => [slug, "the apps edit check (0280, D4): manage of the app's home"] as const,
  ),
  ['app_snapshot_create', 'the node_snapshots edit check (0280)'],
  ['app_snapshot_delete', 'the node_snapshots edit check (0280)'],
]);

describe('the writes the database checks (the pre-check removal)', () => {
  it('each is a builtin that declares no items now', () => {
    expect(DATABASE_CHECKED.size).toBe(69);
    for (const slug of DATABASE_CHECKED.keys()) {
      const def = getBuiltin(slug);
      expect(def, `${slug} is no builtin now: drop it`).not.toBeNull();
      expect(def!.policy.items, `${slug} declares its items again: drop it`).toBeUndefined();
    }
  });
});

/**
 * The writes a workspace turn reaches (scope `any`, an owner-side tool on
 * the web and Telegram too) that name no item and create none, each with
 * why (the A8 fix round 1, L6): since F2 such a turn writes with its
 * user's rights, so every other one declares the items it changes
 * (`items`, read by the item pre-check) or what it creates.
 */
const WORKSPACE_TURN_NO_ITEMS: ReadonlyMap<string, string> = new Map([
  [
    'app_data_write',
    "an app's data: the app's MCP switch and the login's Write switch, in the handler",
  ],
  ['app_undelete', "a deleted app: its home's Moderators only, in the handler (app-trash)"],
  ['invoke_agent', "hands item ids to a child turn that runs in the caller's scope"],
  ['route_map', 'draws a map for the reply; it changes no item'],
  ['show_image', 'reads the image it shows'],
  ['synthesize_speech', 'makes audio for the reply; it changes no item'],
  ['telegram_pair', "pairs the caller's own Telegram chat with its login; no item"],
  ['web_fetch', 'reads a web page (a write by its outside reach); no item'],
  ['web_search', 'searches the web (a write by its outside reach); no item'],
  ['web_search_pro', 'searches the web (a write by its outside reach); no item'],
]);

describe('every write a workspace turn reaches declares its items (A8 fix round 1, L6)', () => {
  it('an item list, a create, or a reason here', () => {
    const reached = listBuiltins().filter(
      (d) => !d.readOnly && d.policy.effect === 'write' && d.policy.scope === 'any',
    );
    expect(reached.length).toBeGreaterThan(50);
    const missing = reached
      .filter((d) => !d.policy.items && !d.policy.creates && !d.policy.createsIn)
      .map((d) => d.slug)
      .filter((slug) => !WORKSPACE_TURN_NO_ITEMS.has(slug) && !DATABASE_CHECKED.has(slug));
    expect(missing).toEqual([]);
    // A reason for a tool that now declares its items, or is gone, goes.
    for (const slug of WORKSPACE_TURN_NO_ITEMS.keys()) {
      const def = getBuiltin(slug);
      expect(def, `${slug} is no builtin now: drop it`).not.toBeNull();
      expect(!!def!.policy.items || !!def!.policy.creates, `${slug} declares now: drop it`).toBe(
        false,
      );
    }
  });
});

describe('the Admin gate lists (W7a fix round 1)', () => {
  it('every whole-system area tool is an area tool that names no item', () => {
    for (const def of systemWhole()) {
      const slug = def.slug;
      expect(areaOf(slug), slug).not.toBeNull();
      expect(builtinItems(slug), slug).toBeUndefined();
      // A contact is an Admin-only kind: a scope that passed the area check
      // holds Admin and reads every contact, so its precondition reads
      // nothing more on the system pool.
      const pre = (def.preconditions ?? []).filter(
        (p) => !(p.kind === 'node_exists' && p.nodeType === 'contact'),
      );
      expect(pre, slug).toEqual([]);
      const props = Object.keys(
        ((def.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}) as object,
      );
      // A peer tool's ids name the PEER's items, read over its link.
      if (slug.startsWith('peer_')) continue;
      for (const p of props) {
        expect(/^(node|file|page|folder|note|table|item)_?ids?$/i.test(p), `${slug}.${p}`).toBe(
          false,
        );
      }
    }
  });

  it('the area tools that touch items run in the scope', () => {
    for (const slug of [
      'sandbox_create',
      'sandbox_import',
      'sandbox_export',
      'peer_file_copy',
      'recipe_tool_test',
      'email_send',
      'email_page',
      'email_list',
      'email_get',
      'run_terminal',
      // W7a fix round 2: each reads, writes or runs something in the scope.
      // (heartbeat_fire too: its policy is on its definition in
      // @mantle/runtime, pinned by packages/runtime/src/tool-policy-snapshot.test.ts.)
      'api_docs_set',
      'api_docs_get',
      'update_persona',
      'api_tool_test',
      'secret_create',
      'brain_capacity',
    ]) {
      expect(areaOf(slug), slug).not.toBeNull();
      expect(policySystemWhole(getBuiltin(slug)!.policy), slug).toBe(false);
    }
  });

  it('run_terminal is adminOnly and needs the settings area (M3)', () => {
    expect(policyAdminOnly(getBuiltin('run_terminal')!.policy)).toBe(true);
    expect(areaOf('run_terminal')).toBe('settings');
    // For a member's scope too (W7b fix round 1, H1): never listed without
    // Admin, nor without the settings area (the gate's Admin step).
    const ref = builtinToolRef('run_terminal', 'run_terminal');
    expect(builtinToolGatePolicy(ref)?.scope).toEqual({ area: 'settings' });
    const lists = (holdsAdmin: boolean, areas: string[]) =>
      gateLists(
        { actor: null, via: 'turn', admin: { holdsAdmin, areas: new Set(areas) } } as GateCaller,
        ref,
      );
    expect(lists(false, ['settings'])).toBe(false);
    expect(lists(true, [])).toBe(false);
    expect(lists(true, ['settings'])).toBe(true);
  });

  it('every item write target names a real builtin and one of its arguments', () => {
    for (const [slug, targets] of itemWrites()) {
      const def = getBuiltin(slug);
      expect(def, slug).not.toBeNull();
      if (typeof targets === 'function') continue;
      const props = Object.keys(
        ((def!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}) as object,
      );
      for (const t of targets) expect(props, `${slug}.${t.param}`).toContain(t.param);
    }
  });

  it('every write that declares a node precondition on an item is checked or reads it', () => {
    const missing = listBuiltins()
      .filter((d) => !d.readOnly)
      .filter((d) => (d.preconditions ?? []).some((p) => p.kind === 'node_exists'))
      .map((d) => d.slug)
      .filter(
        (slug) => !builtinItems(slug) && !READS_ITS_ITEM.has(slug) && !DATABASE_CHECKED.has(slug),
      );
    expect(missing).toEqual([]);
  });

  it('a conversion retires its source unless supersede_source is false (N2)', async () => {
    const cases: Array<[string, Record<string, unknown>, string[]]> = [
      ['page_from_note', { note_id: 'n1' }, ['n1']],
      ['page_from_file', { file_id: 'f1' }, ['f1']],
      ['page_from_notes', { note_ids: ['n1', 'n2'] }, ['n1', 'n2']],
      ['page_from_note', { note_id: 'n1', supersede_source: true }, ['n1']],
    ];
    for (const [slug, input, ids] of cases) {
      const resolve = builtinItems(slug) as unknown as (
        i: Record<string, unknown>,
        o: string,
      ) => Promise<{ ids: string[]; need: string }[]>;
      expect(await resolve(input, 'o'), slug).toEqual([{ ids, need: 'edit' }]);
      expect(await resolve({ ...input, supersede_source: false }, 'o'), slug).toEqual([]);
    }
  });

  it('every write with an id argument is on the item write list or says why not', () => {
    const missing = listBuiltins()
      .filter((d) => !d.readOnly && !d.policy.items)
      .filter((d) =>
        Object.keys(
          ((d.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}) as object,
        ).some((p) => p === 'id' || /_ids?$/.test(p)),
      )
      .map((d) => d.slug)
      .filter((slug) => !NOT_AN_ITEM_WRITE.has(slug) && !DATABASE_CHECKED.has(slug));
    expect(missing).toEqual([]);
    for (const slug of NOT_AN_ITEM_WRITE.keys()) {
      expect(getBuiltin(slug), `${slug} is no builtin now: drop it from the list`).not.toBeNull();
    }
  });

  it('a link needs edit to open (A0); the handler and the database close one', () => {
    for (const slug of ['page_share', 'node_share']) {
      expect(builtinItems(slug), slug).toEqual([{ param: 'id', need: 'edit' }]);
    }
    for (const slug of ['page_unshare', 'node_unshare']) {
      expect(builtinItems(slug), slug).toBeUndefined();
      expect(DATABASE_CHECKED.has(slug), slug).toBe(true);
    }
  });

  it('a copy of an app with its data needs an edit; the code alone a read (M3)', async () => {
    for (const slug of ['app_duplicate', 'app_export']) {
      const resolve = builtinItems(slug) as unknown as (
        i: Record<string, unknown>,
        o: string,
      ) => Promise<{ ids: string[]; need: string }[]>;
      expect(typeof resolve, slug).toBe('function');
      expect(await resolve({ id: 'not-a-uuid' }, 'o'), slug).toEqual([
        { ids: ['not-a-uuid'], need: 'edit' },
      ]);
      expect(await resolve({ id: 'a1', with_data: false }, 'o'), slug).toEqual([
        { ids: ['a1'], need: 'read' },
      ]);
    }
  });
});
