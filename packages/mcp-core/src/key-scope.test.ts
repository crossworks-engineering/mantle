/**
 * An inbound API key on /api/mcp (migration 0232): the area of each tool,
 * and the owner surface an admin key gets. Since W5b2 a key acts exactly as
 * its login: its areas, access and risky-tool names no longer narrow the
 * surface, so an admin key gets the owner's surface as is. Driven through
 * the real registration path against a capturing fake server; no database.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS } from '@mantle/tools';
import { KEY_AREAS, keyAreasAllowTool, toolKeyArea } from './key-scope';
import { registerPreparedTools, type McpCaller } from './login-surface';

function registeredFor(caller: Partial<McpCaller>): string[] {
  const out: string[] = [];
  const fakeServer = { registerTool: (name: string) => void out.push(name) };
  registerPreparedTools(fakeServer as never, {
    kind: 'owner',
    caller: {
      role: 'admin',
      anchorId: 'owner-1',
      loginId: 'login-1',
      via: 'key',
      write: false,
      ...caller,
    },
  });
  return out;
}

describe('API key areas for MCP tools', () => {
  it('maps tool families to their area', () => {
    expect(toolKeyArea('page_get')).toBe('pages');
    expect(toolKeyArea('note_create')).toBe('notes');
    expect(toolKeyArea('task_update')).toBe('tasks');
    expect(toolKeyArea('table_rows_add')).toBe('tables');
    expect(toolKeyArea('file_read')).toBe('files');
    expect(toolKeyArea('folder_list')).toBe('files');
    expect(toolKeyArea('event_list')).toBe('calendar');
    expect(toolKeyArea('contact_get')).toBe('contacts');
    expect(toolKeyArea('journal_create')).toBe('journal');
    expect(toolKeyArea('app_list')).toBe('apps');
    expect(toolKeyArea('search')).toBe('search');
    expect(toolKeyArea('entity_search')).toBe('search');
    expect(toolKeyArea('my_page_create')).toBe('pages');
  });

  it('gives every conversion tool no area: it reads one kind to write another', () => {
    const slugs = new Set([
      ...BUILTIN_TOOLS.map((t) => t.slug),
      ...registeredFor({ areas: null, write: true, riskyAllowed: [] }),
    ]);
    const conversions = [...slugs].filter((s) => s.includes('_from_'));
    expect(conversions).toEqual(expect.arrayContaining(['page_from_journal', 'note_from_page']));
    for (const slug of conversions) expect(toolKeyArea(slug), slug).toBeNull();
    for (const slug of conversions) {
      expect(keyAreasAllowTool(slug, ['pages', 'notes', 'files', 'tables']), slug).toBe(false);
    }
  });

  it('puts the app data tools in their own area, apart from app authoring', () => {
    for (const slug of ['app_data_list', 'app_data_schema', 'app_data_query', 'app_data_write']) {
      expect(toolKeyArea(slug), slug).toBe('app_data');
      expect(keyAreasAllowTool(slug, ['app_data']), slug).toBe(true);
      expect(keyAreasAllowTool(slug, ['apps']), slug).toBe(false);
    }
    expect(keyAreasAllowTool('app_db_query', ['app_data'])).toBe(false);
    expect(keyAreasAllowTool('app_file_write', ['app_data'])).toBe(false);
    expect(KEY_AREAS).toContain('app_data');
  });

  it('leaves everything else to an all-areas key', () => {
    for (const slug of ['recall_open', 'agent_list', 'peer_call', 'email_send', 'tree_list']) {
      expect(toolKeyArea(slug), slug).toBeNull();
      expect(keyAreasAllowTool(slug, null), slug).toBe(true);
      expect(keyAreasAllowTool(slug, [...KEY_AREAS]), slug).toBe(false);
    }
  });

  it('an admin key acts as its login: areas, access and risky names do not narrow it (W5b2)', () => {
    const owner = registeredFor({ via: 'oauth', write: true });
    expect(owner).toContain('email_send');
    expect(owner).toContain('page_create');
    expect(owner).toContain('recall_open');
    for (const caller of [
      { areas: ['tasks'] },
      { areas: ['tasks', 'notes'], write: true },
      { areas: null, write: true },
      { areas: null, write: true, riskyAllowed: ['email_send'] },
    ] satisfies Partial<McpCaller>[]) {
      expect(registeredFor(caller).sort(), JSON.stringify(caller)).toEqual([...owner].sort());
    }
  });
});
