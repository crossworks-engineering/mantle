/**
 * The owner surface a PEER gets when its token acts as the owner (plan page
 * e5b854dd): read-only unless the peer's write switch is on, and never the
 * risky tools unless the owner named them. Driven through the real
 * registration path against a capturing fake server; no database, no model.
 * The DB-backed member and client half is login-surface.viewer.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS } from '@mantle/tools';
import { registerMantleTools } from './build-server';
import {
  MCP_HANDWRITTEN_READ_ONLY,
  isMcpToolReadOnly,
  isPeerRiskyTool,
  loginMayHaveTool,
  mcpInstructionsFor,
  ownerPeerAllows,
} from './login-surface';

function registered(allow?: (slug: string) => boolean): string[] {
  const out: string[] = [];
  const fakeServer = { registerTool: (name: string) => void out.push(name) };
  registerMantleTools(fakeServer as never, 'owner-1', {
    transport: 'http',
    ...(allow ? { allow } : {}),
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

  it('write off: registers only read-only tools, and no risky one', () => {
    const tools = registered((s) => ownerPeerAllows(s, { write: false }));
    expect(tools.length).toBeGreaterThan(20);
    for (const s of tools) {
      expect(isMcpToolReadOnly(s), s).toBe(true);
      expect(isPeerRiskyTool(s), s).toBe(false);
    }
    expect(tools).toContain('search');
    expect(tools).toContain('file_read');
    expect(tools).not.toContain('file_upload');
    expect(tools).not.toContain('note_create');
  });

  it('write on: adds the write tools but keeps the risky ones out', () => {
    const tools = registered((s) => ownerPeerAllows(s, { write: true }));
    for (const s of ['file_upload', 'note_create', 'event_create', 'folder_create']) {
      expect(tools).toContain(s);
    }
    for (const s of [
      'email_send',
      'app_publish',
      'node_share',
      'telegram_send',
      'sandbox_exec',
      'web_search',
      'invoke_agent',
      'secret_create',
      'access_set',
      'pending_approve',
      'agent_grant_tool_group',
      // audit 2026-10-03: runs, mail by page, the allowlist, confirm-gated
      // deletes, live app code, third-brain egress, model routing
      'run_plan',
      'run_append',
      'email_page',
      'contact_create',
      'page_delete',
      'app_source_set',
      'app_tools_set',
      'peer_call',
      'peer_file_copy',
      'model_pool_set',
    ]) {
      expect(tools, s).not.toContain(s);
    }
  });

  it('a risky tool comes back only when the owner names it', () => {
    const tools = registered((s) =>
      ownerPeerAllows(s, { write: true, riskyAllowed: ['email_send'] }),
    );
    expect(tools).toContain('email_send');
    expect(tools).not.toContain('telegram_send');
  });

  it('every spending or confirm-gated builtin counts as risky', () => {
    for (const d of BUILTIN_TOOLS) {
      if (d.spends || d.requiresConfirm) expect(isPeerRiskyTool(d.slug), d.slug).toBe(true);
    }
  });

  it('write off: no peer egress either', () => {
    const tools = registered((s) => ownerPeerAllows(s, { write: false }));
    expect(tools.filter((s) => s.startsWith('peer_'))).toEqual([]);
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
