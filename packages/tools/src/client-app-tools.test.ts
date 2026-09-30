/**
 * The client app tool allowlist (client logins C6): only the client tools a
 * client chat already reads with, never a write, `read_result` or a client's
 * private-item reader, and never a brain-wide read tool. A slug off the list
 * is refused before any lookup, whatever the app declares and whatever a
 * client-level group holds. The rest of the rule is proven on Postgres in
 * client-app-tools.viewer.db.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./resolve', () => ({
  resolveTool: vi.fn(async () => {
    throw new Error('a slug off the list must be refused before any lookup');
  }),
}));

import { BUILTIN_TOOLS } from './builtins';
import { CLIENT_APP_TOOL_SLUGS, clientAppToolVerdict } from './client-app-tools';
import { CLIENT_TURN_TOOL_SLUGS } from './client-turn-tools';

describe('CLIENT_APP_TOOL_SLUGS', () => {
  it('is the client read tools, and a subset of the client chat tools', () => {
    expect([...CLIENT_APP_TOOL_SLUGS].sort()).toEqual(
      ['client_shared_list', 'client_shared_open', 'client_shared_search'].sort(),
    );
    expect(CLIENT_APP_TOOL_SLUGS.filter((s) => !CLIENT_TURN_TOOL_SLUGS.includes(s))).toEqual([]);
  });

  it('holds only read-only builtins that neither spend nor are owner only', () => {
    for (const slug of CLIENT_APP_TOOL_SLUGS) {
      const def = BUILTIN_TOOLS.find((t) => t.slug === slug);
      expect(def, slug).toBeDefined();
      expect(def?.readOnly, slug).toBe(true);
      expect(def?.spends, slug).toBeUndefined();
      expect(def?.ownerOnly, slug).toBeUndefined();
    }
  });

  it('refuses the brain-wide reads, the writes and the private-item readers before any lookup', async () => {
    const off = [
      'search_chunks',
      'page_get',
      'node_read',
      'search',
      'note_list',
      'client_request_create',
      'read_result',
      'my_items_list',
      'my_item_open',
    ];
    for (const slug of off) {
      const v = await clientAppToolVerdict('owner', off, slug);
      expect(v, slug).toMatchObject({ ok: false, status: 403 });
    }
  });

  it('refuses an undeclared slug, even a client tool', async () => {
    const v = await clientAppToolVerdict('owner', [], 'client_shared_list');
    expect(v).toMatchObject({ ok: false, status: 403 });
  });
});
