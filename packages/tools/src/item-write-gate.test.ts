/**
 * W7a fix round 1: the lists the Admin gate and the item edit check run on
 * stay true to the builtins they name.
 *
 *  - H1: a tool that runs WHOLE on the system pool (AREA_SYSTEM_TOOLS) is an
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

import {
  AREA_SYSTEM_TOOLS,
  ADMIN_ONLY_TOOL_SLUGS,
  adminGateLists,
  TOOL_ADMIN_AREAS,
  toolAdminArea,
} from './admin-gate';
import { ITEM_WRITE_TARGETS } from './item-write-gate';
import { getBuiltin, listBuiltins } from './registry';

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

describe('the Admin gate lists (W7a fix round 1)', () => {
  it('every whole-system area tool is an area tool that names no item', () => {
    for (const slug of AREA_SYSTEM_TOOLS) {
      expect(TOOL_ADMIN_AREAS.has(slug), slug).toBe(true);
      expect(ITEM_WRITE_TARGETS.has(slug), slug).toBe(false);
      const def = getBuiltin(slug);
      if (!def) continue; // registered by its own package (the heartbeat tools)
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
      'heartbeat_fire',
      'api_docs_set',
      'api_docs_get',
      'update_persona',
      'api_tool_test',
      'secret_create',
      'brain_capacity',
    ]) {
      expect(toolAdminArea(slug), slug).not.toBeNull();
      expect(AREA_SYSTEM_TOOLS.has(slug), slug).toBe(false);
    }
  });

  it('run_terminal is adminOnly and needs the settings area (M3)', () => {
    expect(ADMIN_ONLY_TOOL_SLUGS.has('run_terminal')).toBe(true);
    expect(toolAdminArea('run_terminal')).toBe('settings');
    // For a member's scope too (W7b fix round 1, H1): never listed without
    // Admin, nor without the settings area.
    expect(
      adminGateLists('run_terminal', { holdsAdmin: false, areas: new Set(['settings']) }),
    ).toBe(false);
    expect(adminGateLists('run_terminal', { holdsAdmin: true, areas: new Set() })).toBe(false);
    expect(adminGateLists('run_terminal', { holdsAdmin: true, areas: new Set(['settings']) })).toBe(
      true,
    );
  });

  it('every item write target names a real builtin and one of its arguments', () => {
    for (const [slug, targets] of ITEM_WRITE_TARGETS) {
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
      .filter((slug) => !ITEM_WRITE_TARGETS.has(slug) && !READS_ITS_ITEM.has(slug));
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
      const resolve = ITEM_WRITE_TARGETS.get(slug) as (
        i: Record<string, unknown>,
        o: string,
      ) => Promise<{ ids: string[]; need: string }[]>;
      expect(await resolve(input, 'o'), slug).toEqual([{ ids, need: 'edit' }]);
      expect(await resolve({ ...input, supersede_source: false }, 'o'), slug).toEqual([]);
    }
  });

  it('every write with an id argument is on the item write list or says why not', () => {
    const missing = listBuiltins()
      .filter((d) => !d.readOnly && !ITEM_WRITE_TARGETS.has(d.slug))
      .filter((d) =>
        Object.keys(
          ((d.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}) as object,
        ).some((p) => p === 'id' || /_ids?$/.test(p)),
      )
      .map((d) => d.slug)
      .filter((slug) => !NOT_AN_ITEM_WRITE.has(slug));
    expect(missing).toEqual([]);
    for (const slug of NOT_AN_ITEM_WRITE.keys()) {
      expect(getBuiltin(slug), `${slug} is no builtin now: drop it from the list`).not.toBeNull();
    }
  });

  it('a link needs edit to open or close; the users area closes any link (A0)', async () => {
    for (const slug of ['page_share', 'node_share']) {
      expect(ITEM_WRITE_TARGETS.get(slug), slug).toEqual([{ param: 'id', need: 'edit' }]);
    }
    for (const slug of ['page_unshare', 'node_unshare']) {
      const resolve = ITEM_WRITE_TARGETS.get(slug) as (
        i: Record<string, unknown>,
        o: string,
        c?: { surface: Record<string, unknown> },
      ) => Promise<{ ids: string[]; need: string }[]>;
      const admin = { surface: { kind: 'owner' as const, via: 'mcp' as const, loginId: 'l' } };
      area.users = false;
      expect(await resolve({ id: 'n1' }, 'o', admin), slug).toEqual([
        { ids: ['n1'], need: 'edit' },
      ]);
      area.users = true;
      expect(await resolve({ id: 'n1' }, 'o', admin), slug).toEqual([]);
      // A key or a linked brain never skips the check (L-e); nor a call
      // with no surface named.
      for (const via of ['api', 'federation'] as const) {
        const key = { surface: { kind: 'owner' as const, via, loginId: 'l' } };
        expect(await resolve({ id: 'n1' }, 'o', key), via).toEqual([{ ids: ['n1'], need: 'edit' }]);
      }
      expect(await resolve({ id: 'n1' }, 'o'), slug).toEqual([{ ids: ['n1'], need: 'edit' }]);
      // Outside a scope the area check says yes by default: not enough (L-4).
      area.scope = false;
      expect(await resolve({ id: 'n1' }, 'o', admin), slug).toEqual([
        { ids: ['n1'], need: 'edit' },
      ]);
      area.scope = true;
    }
  });

  it('a copy of an app with its data needs an edit; the code alone a read (M3)', async () => {
    for (const slug of ['app_duplicate', 'app_export']) {
      const resolve = ITEM_WRITE_TARGETS.get(slug) as (
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
