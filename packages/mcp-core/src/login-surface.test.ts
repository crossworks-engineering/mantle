/**
 * The owner surface a PEER gets when its token acts as the owner (plan page
 * e5b854dd). Since W5b2 a peer acts exactly as its bound login: its write
 * switch and risky-tool names no longer narrow the surface, so a peer bound
 * to the owner gets the owner's surface as is. Driven through the real
 * registration path against a capturing fake server; no database, no model.
 * The DB-backed member and client half is login-surface.viewer.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS } from '@mantle/tools';
import { registerMantleTools } from './build-server';
import {
  MCP_HANDWRITTEN_READ_ONLY,
  isMcpToolReadOnly,
  loginMayHaveTool,
  mcpInstructionsFor,
  registerPreparedTools,
  type McpCaller,
} from './login-surface';

function registered(): string[] {
  const out: string[] = [];
  const fakeServer = { registerTool: (name: string) => void out.push(name) };
  registerMantleTools(fakeServer as never, 'owner-1', { transport: 'http' });
  return out;
}

function registeredForPeer(peer: Partial<McpCaller>): string[] {
  const out: string[] = [];
  const fakeServer = { registerTool: (name: string) => void out.push(name) };
  registerPreparedTools(fakeServer as never, {
    kind: 'owner',
    caller: {
      role: 'admin',
      anchorId: 'owner-1',
      loginId: 'owner-1',
      via: 'peer',
      write: false,
      ...peer,
    },
  });
  return out;
}

describe('owner surface for a peer', () => {
  it('the hand-written read set names only tools the surface registers', () => {
    const all = registered();
    for (const s of MCP_HANDWRITTEN_READ_ONLY) expect(all).toContain(s);
    // The hand-written writes and spenders are not in it.
    for (const s of ['file_rename', 'folder_rename', 'folder_describe', 'ask_responder']) {
      expect(isMcpToolReadOnly(s), s).toBe(false);
    }
  });

  it('a peer bound to the owner acts as the owner: write off and risky names do not narrow it (W5b2)', () => {
    const owner = registered();
    for (const s of ['file_upload', 'note_create', 'email_send', 'peer_call', 'access_set']) {
      expect(owner, s).toContain(s);
    }
    for (const peer of [
      { write: false },
      { write: true },
      { write: true, riskyAllowed: ['email_send'] },
    ] satisfies Partial<McpCaller>[]) {
      expect(registeredForPeer(peer).sort(), JSON.stringify(peer)).toEqual([...owner].sort());
    }
  });
});

describe('member and client tool filter', () => {
  const row = (slug: string, extra: Record<string, unknown> = {}) =>
    ({ slug, handler: { kind: 'builtin', ref: slug }, requiresConfirm: false, ...extra }) as never;

  it('write off: read-only builtins only', () => {
    expect(loginMayHaveTool(row('note_list'), false)).toBe(true);
    expect(loginMayHaveTool(row('note_create'), false)).toBe(false);
    expect(loginMayHaveTool(row('my_note_create'), false)).toBe(false);
    expect(loginMayHaveTool(row('team_request_create'), false)).toBe(false);
  });

  it('write on: draft and request tools, never a library write', () => {
    expect(loginMayHaveTool(row('my_note_create'), true)).toBe(true);
    expect(loginMayHaveTool(row('my_file_upload'), true)).toBe(true);
    expect(loginMayHaveTool(row('team_request_create'), true)).toBe(true);
    expect(loginMayHaveTool(row('note_create'), true)).toBe(false);
    expect(loginMayHaveTool(row('file_upload'), true)).toBe(false);
  });

  it('app data: the reads always, the write only with write on', () => {
    for (const slug of ['app_data_list', 'app_data_schema', 'app_data_query']) {
      expect(loginMayHaveTool(row(slug), false), slug).toBe(true);
    }
    expect(loginMayHaveTool(row('app_data_write'), false)).toBe(false);
    expect(loginMayHaveTool(row('app_data_write'), true)).toBe(true);
  });

  it('never a non-builtin, a renamed builtin, a confirm-gated, spending or owner-only tool', () => {
    expect(loginMayHaveTool({ slug: 'x', handler: { kind: 'http' } } as never, true)).toBe(false);
    expect(
      loginMayHaveTool(
        { slug: 'alias', handler: { kind: 'builtin', ref: 'note_list' } } as never,
        false,
      ),
    ).toBe(false);
    expect(loginMayHaveTool(row('note_list', { requiresConfirm: true }), false)).toBe(false);
    for (const d of BUILTIN_TOOLS) {
      if (d.spends || d.ownerOnly || d.mcpOnly) {
        expect(loginMayHaveTool(row(d.slug), true), d.slug).toBe(false);
      }
    }
  });

  it('tells a login who it acts as', () => {
    const base = { anchorId: 'a', loginId: 'l', via: 'oauth' as const };
    expect(mcpInstructionsFor({ ...base, role: 'member', write: false })).toContain('read-only');
    expect(mcpInstructionsFor({ ...base, role: 'client', write: true })).toContain(
      'my_note_create',
    );
  });
});
