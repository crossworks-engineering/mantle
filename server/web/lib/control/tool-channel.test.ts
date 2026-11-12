/**
 * The admin channel's box side (tool-channel.ts, docs/control-center.md
 * "The admin channel"): the scope line, the lists built from the tools'
 * metadata, the never list, the nonce, the caps, the one dispatcher and
 * the audit detail. The signed route around it: tool-channel.db.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as { input: Record<string, unknown>; ctx: Record<string, unknown> }[],
  answer: null as null | (() => Promise<unknown>),
}));
vi.mock('@mantle/tools', async (orig) => {
  const actual = await orig<typeof import('@mantle/tools')>();
  return {
    ...actual,
    dispatchTool: (_row: unknown, input: Record<string, unknown>, ctx: Record<string, unknown>) => {
      h.calls.push({ input, ctx });
      return h.answer ? h.answer() : Promise.resolve({ ok: true, output: { done: true } });
    },
  };
});

const {
  allowedToolNames,
  forgetNonces,
  listToolsForCenter,
  NONCE_MAX,
  REVIEWED_USERS_TOOLS,
  NONCE_TTL_MS,
  runToolCall,
  takeNonce,
  toolAllowed,
  toolAuditDetail,
} = await import('./tool-channel');
const { listBuiltins } = await import('@mantle/tools');

const ANCHOR = '00000000-0000-4000-8000-0000000000aa';
const call = (name: string, args: Record<string, unknown> = {}, nonce = crypto.randomUUID()) => ({
  op: 'tool' as const,
  args: { nonce, name, args },
});

afterEach(() => {
  vi.unstubAllEnvs();
  h.calls = [];
  h.answer = null;
  forgetNonces();
});

describe('the scope line', () => {
  it('absent, empty or admin: admin (owner decision: admin by default)', async () => {
    for (const v of [undefined, '', '  ', 'admin', 'ADMIN']) {
      if (v === undefined) vi.stubEnv('MANTLE_CONTROL_CENTER_SCOPE', undefined as never);
      else vi.stubEnv('MANTLE_CONTROL_CENTER_SCOPE', v);
      expect((await runToolCall(ANCHOR, call('agent_list'))).ok, String(v)).toBe(true);
      expect(listToolsForCenter().scope, String(v)).toBe('admin');
      expect((await runToolCall(ANCHOR, call('file_read'))).reason, String(v)).toBe('tool');
    }
  });

  it('full stays full: data reads too', async () => {
    vi.stubEnv('MANTLE_CONTROL_CENTER_SCOPE', 'full');
    expect(listToolsForCenter().scope).toBe('full');
    expect((await runToolCall(ANCHOR, call('file_read'))).ok).toBe(true);
  });

  it('none, or any other word (fails closed): refused, and nothing is listed or run', async () => {
    for (const v of ['none', 'NONE', 'yes', 'on', 'owner', 'fulll', 'admin,full']) {
      vi.stubEnv('MANTLE_CONTROL_CENTER_SCOPE', v);
      expect(await runToolCall(ANCHOR, call('agent_list'))).toEqual({
        name: 'agent_list',
        ok: false,
        reason: 'scope',
      });
      expect(listToolsForCenter()).toEqual({ scope: null, tools: [] });
    }
    expect(h.calls).toEqual([]);
  });
});

describe('the lists', () => {
  const admin = allowedToolNames('admin');
  const full = allowedToolNames('full');

  it('admin: settings and management tools', () => {
    for (const t of [
      'agent_list',
      'agent_grant_tool_group',
      'model_pool_set',
      'model_pool_list',
      'api_key_set',
      'api_key_refs',
      'tool_group_ensure',
      'worker_group_ensure',
      'update_notice_on',
      'update_notice_off',
      'workspaces_list',
      'box_status',
    ]) {
      expect(admin, t).toContain(t);
    }
  });

  it('admin: no data reads, no code, sandbox or run execution', () => {
    for (const t of [
      'file_read',
      'file_list',
      'page_get',
      'table_sql',
      'table_rows_list',
      'search_nodes',
      'search_chunks',
      'email_list',
      'email_get',
      'note_get',
      'task_list',
      'peer_query',
      'telegram_send',
      'code_write',
      'app_create',
      'sandbox_exec',
      'run_terminal',
      'run_plan',
      'recall_map_get',
      'web_crawl',
      'invoke_agent',
      'model_call',
    ]) {
      expect(admin, t).not.toContain(t);
    }
    // Every admin tool is one of an Admin area's, a reviewed users tool, or
    // the named read.
    for (const name of admin) {
      const def = listBuiltins().find((d) => d.slug === name)!;
      const s = (def.policy as { scope?: unknown }).scope;
      const area = typeof s === 'object' && s ? (s as { area?: string }).area : null;
      expect(
        name === 'workspaces_list' ||
          REVIEWED_USERS_TOOLS.has(name) ||
          ['settings', 'assistants', 'keys'].includes(area ?? ''),
        name,
      ).toBe(true);
    }
  });

  it("never: the brain's own shell, in any scope; a Toolsmith write only while the box keeps it on", () => {
    expect(full).not.toContain('run_terminal');
    expect(admin).not.toContain('run_terminal');
    const writes = listBuiltins()
      .filter((d) => d.optIn === 'toolsmithWrite')
      .map((d) => d.slug);
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(full, w).toContain(w);
    vi.stubEnv('MANTLE_MCP_TOOLSMITH_WRITE', 'off');
    const off = allowedToolNames('full');
    for (const w of writes) expect(off, w).not.toContain(w);
  });

  it('full: every builtin but the never list', () => {
    expect(full).toContain('file_read');
    expect(full).toContain('table_sql');
    expect(full.length).toBeGreaterThan(admin.length);
    for (const name of [...admin, ...full]) expect(name).not.toMatch(/^control_/);
  });

  it('never: a login tool only once reviewed for the owner rule; a vault value stays sealed', () => {
    // A builtin of the users area, or one named for logins, users, members
    // or the owner, must be on the reviewed list (it never touches the box
    // owner, never changes a role, never sets a password): a new one fails
    // here until someone reads it against the owner rule.
    for (const d of listBuiltins()) {
      const s = (d.policy as { scope?: unknown }).scope;
      const area = typeof s === 'object' && s ? (s as { area?: string }).area : null;
      const loginish =
        area === 'users' ||
        /^(user|users|login|logins|owner|member|members|workspace_user)_/.test(d.slug);
      if (loginish) expect(REVIEWED_USERS_TOOLS.has(d.slug), d.slug).toBe(true);
    }
    // The vault's own reads hand out no plaintext (their own tests pin it);
    // no tool of any scope is named to reveal one.
    for (const name of full) expect(name).not.toMatch(/reveal|plaintext|_secret_get|key_get$/);
  });
});

describe('the users area', () => {
  const def = (slug: string) =>
    ({
      slug,
      description: '',
      inputSchema: { type: 'object' },
      policy: { effect: 'write', spends: 'none', scope: { area: 'users' } },
    }) as never;

  it('admin holds a reviewed users tool, and no other', () => {
    expect(toolAllowed('admin', def('users_list'))).toBe(true);
    expect(toolAllowed('admin', def('workspace_user_set'))).toBe(true);
    expect(toolAllowed('admin', def('user_password_set'))).toBe(false);
    expect(toolAllowed('admin', def('user_create'))).toBe(false);
    // full holds every builtin, as the box owner chose.
    expect(toolAllowed('full', def('user_create'))).toBe(true);
  });
});

describe('a call', () => {
  it('runs through the one dispatcher, as the brain on its own surface, a process caller', async () => {
    vi.stubEnv('MANTLE_CONTROL_CENTER_SCOPE', 'admin');
    const r = await runToolCall(ANCHOR, call('agent_list', { limit: 5, confirm: true }));
    expect(r).toEqual({ name: 'agent_list', ok: true, output: { done: true } });
    expect(h.calls).toHaveLength(1);
    const c = h.calls[0]!;
    // The Control Center is not a person: it never confirms.
    expect(c.input).toEqual({ limit: 5 });
    expect(c.ctx).toMatchObject({ ownerId: ANCHOR, surface: { kind: 'owner', via: 'api' } });
    expect(c.ctx.caller).toMatchObject({ entry: 'api-v1', masks: true });
  });

  it('a tool the scope does not allow, or no such tool: `tool`, nothing run', async () => {
    vi.stubEnv('MANTLE_CONTROL_CENTER_SCOPE', 'admin');
    expect((await runToolCall(ANCHOR, call('file_read'))).reason).toBe('tool');
    expect((await runToolCall(ANCHOR, call('no_such_tool'))).reason).toBe('tool');
    vi.stubEnv('MANTLE_CONTROL_CENTER_SCOPE', 'full');
    expect((await runToolCall(ANCHOR, call('control_box_list'))).reason).toBe('tool');
    expect(h.calls).toEqual([]);
  });

  it('args over the cap: `size`; a refusal keeps its own text; a throw never', async () => {
    vi.stubEnv('MANTLE_CONTROL_CENTER_SCOPE', 'full');
    expect((await runToolCall(ANCHOR, call('agent_list', { x: 'y'.repeat(33_000) }))).reason).toBe(
      'size',
    );
    h.answer = () => Promise.resolve({ ok: false, error: 'limit must be 1 to 50' });
    expect(await runToolCall(ANCHOR, call('agent_list'))).toEqual({
      name: 'agent_list',
      ok: false,
      reason: 'refused',
      error: 'limit must be 1 to 50',
    });
    h.answer = () => Promise.reject(new Error('relation "secret_table" does not exist'));
    expect(await runToolCall(ANCHOR, call('agent_list'))).toEqual({
      name: 'agent_list',
      ok: false,
      reason: 'error',
    });
  });

  it('an output over the cap comes back as its head, marked truncated', async () => {
    vi.stubEnv('MANTLE_CONTROL_CENTER_SCOPE', 'full');
    h.answer = () => Promise.resolve({ ok: true, output: { big: 'z'.repeat(100_000) } });
    const r = await runToolCall(ANCHOR, call('agent_list'));
    expect(r.truncated).toBe(true);
    expect(typeof r.output).toBe('string');
    expect((r.output as string).length).toBeLessThanOrEqual(8_000);
  });
});

describe('the nonce', () => {
  it('a second use is refused, within its time and after it is gone', async () => {
    vi.stubEnv('MANTLE_CONTROL_CENTER_SCOPE', 'admin');
    const once = call('agent_list');
    expect((await runToolCall(ANCHOR, once)).ok).toBe(true);
    expect(await runToolCall(ANCHOR, once)).toEqual({
      name: 'agent_list',
      ok: false,
      reason: 'replay',
    });
    expect(h.calls).toHaveLength(1);
    const n = crypto.randomUUID();
    expect(takeNonce(n, 1_000)).toBe('ok');
    expect(takeNonce(n.toUpperCase(), 1_000 + NONCE_TTL_MS - 1)).toBe('replay');
    // Kept longer than the signature's 60 seconds either way.
    expect(NONCE_TTL_MS).toBeGreaterThan(120_000);
  });

  it('a full store refuses (fail closed) until old ones go', () => {
    for (let i = 0; i < NONCE_MAX; i++) expect(takeNonce(crypto.randomUUID(), 5_000)).toBe('ok');
    expect(takeNonce(crypto.randomUUID(), 5_000)).toBe('busy');
    expect(takeNonce(crypto.randomUUID(), 5_001 + NONCE_TTL_MS)).toBe('ok');
  });
});

describe('the list and the audit row', () => {
  it('tools: the scope and each allowed tool with its schema', () => {
    vi.stubEnv('MANTLE_CONTROL_CENTER_SCOPE', 'admin');
    const l = listToolsForCenter();
    expect(l.scope).toBe('admin');
    expect(l.tools.map((t) => t.name)).toEqual(allowedToolNames('admin'));
    const one = l.tools.find((t) => t.name === 'agent_list')!;
    expect(one.inputSchema).toMatchObject({ type: 'object' });
    expect(one.description.length).toBeLessThanOrEqual(600);
  });

  it('names the tool, ok or the reason, and a hash of the args, never the args', () => {
    const c = call('api_key_set', { name: 'openrouter', value: 'sk-or-very-secret' });
    const d = toolAuditDetail(c, { name: 'api_key_set', ok: false, reason: 'refused' });
    expect(d).toMatchObject({ tool: 'api_key_set', ok: false, reason: 'refused' });
    expect(d.argsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(d)).not.toContain('sk-or');
  });
});
