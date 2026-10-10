/**
 * An inbound API key on /api/mcp (migration 0232): the owner surface an
 * admin key gets. Since W5b2 a key acts exactly as
 * its login: its areas, access and risky-tool names no longer narrow the
 * surface, so an admin key gets the owner's surface as is. Driven through
 * the real registration path against a capturing fake server; no database.
 */
import { describe, expect, it } from 'vitest';
import { KEY_AREAS } from './key-scope';
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

describe('API keys on MCP', () => {
  it('keeps the stored area names (accepted, narrowing nothing)', () => {
    expect(KEY_AREAS).toContain('app_data');
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
