/**
 * Behavioural tests for the last two destructive tools: sandbox_rm and
 * api_tool_delete.
 *
 * `sandbox_rm`'s safety margin is one strict equality. The container always
 * goes; the /files WORK DIRECTORY survives unless `purge_files` is exactly
 * `true` (`input.purge_files === true`). That strictness is the point — a
 * truthy-but-not-true value, the string 'false' being the obvious one, must
 * not delete the user's work. The purge is expressed as a `?purge=1` query on
 * the daemon call, so the tests assert the URL, which is the only place the
 * decision becomes visible.
 *
 * `api_tool_delete` resolves the slug to a row before deleting, so a bad slug
 * fails without a delete being attempted. Its description warns that deleting
 * a tool other agents hold breaks them silently — that warning is the only
 * cue the model gets, so it is pinned too.
 *
 * The daemon is stubbed at `fetch`; the db lookups at the select chain.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const toolRow = { id: 't1', ownerId: 'o1', slug: 'my_tool', kind: 'http' };
let selectRows: unknown[] = [toolRow];

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(async () => selectRows),
    then: (res: (v: unknown) => void) => Promise.resolve(selectRows).then(res),
  };
  return { ...actual, db: { ...actual.db, select: vi.fn(() => chain) } };
});
vi.mock('@mantle/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/config')>();
  // sandboxd() short-circuits to "not enabled" without both of these.
  return {
    ...actual,
    env: ((name: string) =>
      name === 'SANDBOXD_URL'
        ? 'http://sandboxd.test'
        : name === 'SANDBOXD_TOKEN'
          ? 'tok'
          : actual.env(name as Parameters<typeof actual.env>[0])) as typeof actual.env,
  };
});
vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return { ...actual, getSandboxByRef: vi.fn(), deleteSandboxRow: vi.fn() };
});
vi.mock('./crud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./crud')>();
  return { ...actual, deleteTool: vi.fn() };
});

import { getSandboxByRef, deleteSandboxRow } from '@mantle/content';
import { deleteTool } from './crud';
import { SANDBOX_TOOLS } from './builtins-sandbox';
import { TOOLSMITH_TOOLS } from './builtins-toolsmith';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const rm = SANDBOX_TOOLS.find((t) => t.slug === 'sandbox_rm')!;
const apiDel = TOOLSMITH_TOOLS.find((t) => t.slug === 'api_tool_delete')!;

const ctx: ToolHandlerContext = { ownerId: 'o1' };

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

/** The URL the daemon was called with, or '' if it was never called. */
function daemonUrl(): string {
  const call = vi.mocked(global.fetch).mock.calls[0];
  return call ? String(call[0]) : '';
}

beforeEach(() => {
  vi.clearAllMocks();
  selectRows = [toolRow];
  vi.mocked(getSandboxByRef).mockResolvedValue({ id: 'sb1', name: 'scratch' } as never);
  vi.mocked(deleteSandboxRow).mockResolvedValue(undefined as never);
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ filesPreserved: true, filesDir: '/data/sandboxes/sb1/files' }),
  })) as unknown as typeof fetch;
});

describe('sandbox_rm', () => {
  it('is confirm-gated', () => {
    expect(rm.requiresConfirm).toBe(true);
  });

  it('reports a sandbox that does not exist, and calls no daemon', async () => {
    vi.mocked(getSandboxByRef).mockResolvedValue(null as never);
    expect(errorOf(await rm.handler({ sandbox: 'ghost' }, ctx))).toMatch(/not found|sandbox_list/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('PRESERVES the work directory by default', async () => {
    const res = await rm.handler({ sandbox: 'scratch' }, ctx);
    // No ?purge=1 → the daemon keeps /files. This is the default a user gets
    // when they say "remove the sandbox" without mentioning their work.
    expect(daemonUrl()).not.toMatch(/purge=1/);
    expect(outputOf(res).filesPreserved).toBe(true);
    expect(outputOf(res).filesDir).toBe('/data/sandboxes/sb1/files');
  });

  it('purges ONLY when purge_files is exactly true', async () => {
    await rm.handler({ sandbox: 'scratch', purge_files: true }, ctx);
    expect(daemonUrl()).toMatch(/purge=1/);
  });

  it.each([
    ['the string "false"', 'false'],
    ['the string "true"', 'true'],
    ['the number 1', 1],
    ['null', null],
  ])('does NOT purge for %s', async (_label, value) => {
    // `input.purge_files === true` is the whole safety margin. Anything
    // truthy-but-not-true — a coerced string from a model especially — must
    // leave the user's work on disk.
    await rm.handler({ sandbox: 'scratch', purge_files: value }, ctx);
    expect(daemonUrl()).not.toMatch(/purge=1/);
  });

  it('does not drop the db row when the daemon refused', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: 'busy' }),
    })) as unknown as typeof fetch;
    const res = await rm.handler({ sandbox: 'scratch' }, ctx);
    expect(res.ok).toBe(false);
    // Dropping the row here would orphan a container that still exists, and
    // the name would be freed for a sandbox that is not gone.
    expect(deleteSandboxRow).not.toHaveBeenCalled();
  });
});

describe('api_tool_delete', () => {
  it('refuses an unknown slug WITHOUT attempting a delete', async () => {
    selectRows = [];
    const res = await apiDel.handler({ slug: 'nope' }, ctx);
    expect(errorOf(res)).toMatch(/'nope' not found/);
    expect(deleteTool).not.toHaveBeenCalled();
  });

  it('deletes by the resolved ROW id, not the slug', async () => {
    vi.mocked(deleteTool).mockResolvedValue(true as never);
    const res = await apiDel.handler({ slug: 'my_tool' }, ctx);
    // Passing the slug would delete nothing while still reporting success.
    expect(deleteTool).toHaveBeenCalledWith('o1', 't1');
    expect(outputOf(res)).toEqual({ slug: 'my_tool', deleted: true });
  });

  it('reports a store miss as a failure, not a deletion', async () => {
    vi.mocked(deleteTool).mockResolvedValue(false as never);
    expect(errorOf(await apiDel.handler({ slug: 'my_tool' }, ctx))).toMatch(/not found/);
  });

  it('surfaces a store failure instead of reporting success', async () => {
    vi.mocked(deleteTool).mockRejectedValue(new Error('fk violation'));
    expect(errorOf(await apiDel.handler({ slug: 'my_tool' }, ctx))).toBe('fk violation');
  });

  it('keeps warning that deleting a shared tool breaks agents silently', () => {
    // There is no runtime guard for this — the description is the only cue the
    // model gets before removing a tool other agents hold.
    expect(apiDel.description).toMatch(/tool_group_list/);
    expect(apiDel.description).toMatch(/breaks them silently/i);
  });
});
