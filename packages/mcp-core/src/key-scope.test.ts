/**
 * An inbound API key on /api/mcp (migration 0232): the area of each tool,
 * and the owner surface an admin key gets. Driven through the real
 * registration path against a capturing fake server; no database.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS } from '@mantle/tools';
import { KEY_AREAS, keyAreasAllowTool, toolKeyArea } from './key-scope';
import {
  isMcpToolReadOnly,
  isPeerRiskyTool,
  registerPreparedTools,
  type McpCaller,
} from './login-surface';

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
    const pagesKey = registeredFor({ areas: ['pages', 'notes', 'files', 'tables'], write: true });
    for (const slug of conversions) expect(pagesKey, slug).not.toContain(slug);
  });

  it('leaves everything else to an all-areas key', () => {
    for (const slug of ['recall_open', 'agent_list', 'peer_call', 'email_send', 'tree_list']) {
      expect(toolKeyArea(slug), slug).toBeNull();
      expect(keyAreasAllowTool(slug, null), slug).toBe(true);
      expect(keyAreasAllowTool(slug, [...KEY_AREAS]), slug).toBe(false);
    }
  });

  it('an admin key limited to tasks, read only, gets the task reads and nothing else', () => {
    const tools = registeredFor({ areas: ['tasks'] });
    expect(tools.length).toBeGreaterThan(0);
    expect(tools).toContain('task_list');
    expect(tools).toContain('task_get');
    for (const s of tools) {
      expect(toolKeyArea(s), s).toBe('tasks');
      expect(isMcpToolReadOnly(s), s).toBe(true);
    }
  });

  it('read_write adds the writes in its areas, never the risky tools', () => {
    const tools = registeredFor({ areas: ['tasks', 'notes'], write: true });
    expect(tools).toContain('task_create');
    expect(tools).toContain('note_create');
    expect(tools).not.toContain('page_create');
    for (const s of tools) expect(isPeerRiskyTool(s), s).toBe(false);
  });

  it('an all-areas key is the owner-peer surface: risky tools only by name', () => {
    const plain = registeredFor({ areas: null, write: true });
    expect(plain).not.toContain('email_send');
    expect(plain).toContain('recall_open');
    const named = registeredFor({ areas: null, write: true, riskyAllowed: ['email_send'] });
    expect(named).toContain('email_send');
  });
});
