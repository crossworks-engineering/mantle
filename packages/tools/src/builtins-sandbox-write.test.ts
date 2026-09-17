/**
 * Behavioural tests for the sandbox WRITE tools: sandbox_create,
 * sandbox_exec, sandbox_stop, sandbox_autostart, sandbox_export,
 * sandbox_import, sandbox_publish. `builtins-sandbox-toolsmith-delete.test.ts`
 * covers sandbox_rm.
 *
 * Every tool but create starts with `getSandboxByRef(ownerId, ref)`, and
 * that lookup is the whole ownership boundary: a sandbox that is not the
 * caller's resolves to nothing, and NOTHING may reach the daemon after a
 * miss. For `sandbox_exec` that means a command never runs; for `publish`
 * it means no proxy token is vaulted and no tool group appears. The tests
 * pin the daemon calls (URL, method, body) because the daemon is where a
 * decision becomes irreversible, and pin the db side effects that follow a
 * daemon SUCCESS but must not follow a daemon refusal (a row for a container
 * that does not exist, a status flip for a container still running).
 *
 * The daemon is stubbed at `fetch`; the row helpers at @mantle/content; the
 * file store at @mantle/files; the tool-group lookup at the db select chain.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

let selectRows: unknown[] = [];
/** Where clauses handed to the select, in call order. A `mockReturnThis()`
 *  where accepts any clause, so the owner-id term is read out of these. */
const selectWheres: unknown[] = [];
const updateWheres: unknown[] = [];

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const select = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn(function (this: unknown, clause: unknown) {
      selectWheres.push(clause);
      return this;
    }),
    limit: vi.fn(async () => selectRows),
  };
  const update = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn(async (clause: unknown) => {
      updateWheres.push(clause);
      return [];
    }),
  };
  const insert = { values: vi.fn(async () => []) };
  return {
    ...actual,
    db: {
      ...actual.db,
      select: vi.fn(() => select),
      update: vi.fn(() => update),
      insert: vi.fn(() => insert),
    },
    __update: update,
    __insert: insert,
  };
});
vi.mock('@mantle/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/config')>();
  return {
    ...actual,
    env: ((name: string) =>
      name === 'SANDBOXD_URL'
        ? 'http://sandboxd.test'
        : name === 'SANDBOXD_TOKEN'
          ? 'tok'
          : name === 'SANDBOX_DEFAULT_IMAGE'
            ? undefined
            : actual.env(name as Parameters<typeof actual.env>[0])) as typeof actual.env,
  };
});
vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...actual,
    getSandboxByRef: vi.fn(),
    createSandboxRow: vi.fn(),
    setSandboxStatus: vi.fn(),
    touchSandbox: vi.fn(),
    deleteSandboxRow: vi.fn(),
  };
});
vi.mock('@mantle/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/files')>();
  return {
    ...actual,
    createFolder: vi.fn(),
    ensureFilesRootBranch: vi.fn(),
    folderById: vi.fn(),
    folderByPath: vi.fn(),
    readFileById: vi.fn(),
    upsertFile: vi.fn(),
    diskPathForLtree: vi.fn(),
    filesRoot: vi.fn(),
  };
});
vi.mock('@mantle/api-keys', () => ({ setApiKey: vi.fn() }));
vi.mock('node:fs/promises', () => ({ stat: vi.fn() }));

import * as dbmod from '@mantle/db';
import { createSandboxRow, getSandboxByRef, setSandboxStatus, touchSandbox } from '@mantle/content';
import {
  createFolder,
  diskPathForLtree,
  ensureFilesRootBranch,
  filesRoot,
  folderById,
  folderByPath,
  readFileById,
  upsertFile,
} from '@mantle/files';
import { setApiKey } from '@mantle/api-keys';
import { stat } from 'node:fs/promises';
import { paramsOf } from './test-support';
import { SANDBOX_TOOLS } from './builtins-sandbox';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

type Chain = { set: ReturnType<typeof vi.fn>; values: ReturnType<typeof vi.fn> };
const update = (dbmod as unknown as { __update: Chain }).__update;
const insert = (dbmod as unknown as { __insert: Chain }).__insert;

const tool = (slug: string) => SANDBOX_TOOLS.find((t) => t.slug === slug)!;
const create = tool('sandbox_create');
const exec = tool('sandbox_exec');
const stop = tool('sandbox_stop');
const autostart = tool('sandbox_autostart');
const exportTool = tool('sandbox_export');
const importTool = tool('sandbox_import');
const publish = tool('sandbox_publish');

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const ROW = { id: 'sb1', name: 'scratch', status: 'stopped' };
const DEFAULT_IMAGE = 'titanwest/mantle-sandbox:24.04-v2';

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

/** The daemon calls made so far: url, method, and the JSON body (or the raw
 *  body for the binary import stream). */
function daemonCalls(): Array<{ url: string; method: string; body: unknown }> {
  return vi.mocked(global.fetch).mock.calls.map(([url, init]) => {
    const raw = (init as RequestInit | undefined)?.body;
    const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { url: String(url), method: String((init as RequestInit)?.method ?? 'GET'), body };
  });
}

/** Point the daemon stub at one response for every call. */
function daemonReplies(data: Record<string, unknown>, ok = true, bytes?: Buffer): void {
  global.fetch = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 409,
    json: async () => data,
    arrayBuffer: async () => {
      const b = bytes ?? Buffer.alloc(0);
      // Slice out of Buffer's shared pool: `.buffer` alone is the whole 8 KB arena.
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectRows = [];
  selectWheres.length = 0;
  updateWheres.length = 0;
  daemonReplies({ containerId: 'c1' });
  vi.mocked(getSandboxByRef).mockResolvedValue(ROW as never);
  vi.mocked(createSandboxRow).mockImplementation(async (input) => input as never);
  vi.mocked(setSandboxStatus).mockResolvedValue(undefined);
  vi.mocked(touchSandbox).mockResolvedValue(undefined);
  vi.mocked(ensureFilesRootBranch).mockResolvedValue(undefined as never);
  vi.mocked(folderByPath).mockResolvedValue({ id: 'f-exports' } as never);
  vi.mocked(createFolder).mockResolvedValue(undefined as never);
  vi.mocked(upsertFile).mockResolvedValue({ id: 'node-1' } as never);
  vi.mocked(readFileById).mockResolvedValue({
    row: { filename: 'reg.accdb' },
    bytes: Buffer.from('bytes'),
  } as never);
  vi.mocked(setApiKey).mockResolvedValue(undefined as never);
  vi.mocked(filesRoot).mockReturnValue('/data/files');
  vi.mocked(diskPathForLtree).mockReturnValue('/data/files/inbox');
  vi.mocked(folderById).mockResolvedValue({ path: 'files.inbox', title: 'inbox' } as never);
  vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never);
});

describe('sandbox_create', () => {
  it('rejects a bad name before any lookup or daemon call', async () => {
    for (const name of ['A', 'Has Space', 'x'.repeat(33), '-lead']) {
      expect(errorOf(await create.handler({ name }, ctx))).toMatch(/name must match/);
    }
    expect(getSandboxByRef).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses a name the owner already uses, pointing at sandbox_exec', async () => {
    const res = await create.handler({ name: 'scratch' }, ctx);
    expect(errorOf(res)).toMatch(/'scratch' already exists \(status stopped\)/);
    expect(errorOf(res)).toMatch(/sandbox_exec/);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(createSandboxRow).not.toHaveBeenCalled();
  });

  it('asks the daemon for a container under the owner, then records the row', async () => {
    vi.mocked(getSandboxByRef).mockResolvedValue(null);
    const res = await create.handler({ name: 'proj', description: 'inspect it' }, ctx);
    const [call] = daemonCalls();
    expect(call).toMatchObject({ url: 'http://sandboxd.test/sandboxes', method: 'POST' });
    expect(call!.body).toMatchObject({
      ownerId: 'o1',
      image: DEFAULT_IMAGE,
      network: 'full',
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    // The row carries the daemon's container id, and the SAME id the daemon
    // was given, so the two sides can never disagree on which sandbox this is.
    expect(createSandboxRow).toHaveBeenCalledWith({
      id: (call!.body as { id: string }).id,
      ownerId: 'o1',
      name: 'proj',
      description: 'inspect it',
      image: DEFAULT_IMAGE,
      network: 'full',
      status: 'running',
      containerId: 'c1',
    });
    expect(outputOf(res)).toMatchObject({ name: 'proj', status: 'running', filesDir: '/files' });
  });

  it('accepts only the three egress tiers and falls back to full', async () => {
    vi.mocked(getSandboxByRef).mockResolvedValue(null);
    await create.handler({ name: 'p1', network: 'none' }, ctx);
    await create.handler({ name: 'p2', network: 'balanced' }, ctx);
    await create.handler({ name: 'p3', network: 'wide-open' }, ctx);
    expect(daemonCalls().map((c) => (c.body as { network: string }).network)).toEqual([
      'none',
      'balanced',
      'full',
    ]);
  });

  it('records NO row when the daemon refused', async () => {
    vi.mocked(getSandboxByRef).mockResolvedValue(null);
    daemonReplies({ error: 'disk full' }, false);
    expect(errorOf(await create.handler({ name: 'proj' }, ctx))).toBe('disk full');
    // A row without a container would make the name unusable AND unexplainable.
    expect(createSandboxRow).not.toHaveBeenCalled();
  });

  it('mounts an inbox folder by its path RELATIVE to the Files root', async () => {
    vi.mocked(getSandboxByRef).mockResolvedValue(null);
    await create.handler({ name: 'proj', inbox_folder_id: 'f1' }, ctx);
    expect(folderById).toHaveBeenCalledWith({ ownerId: 'o1', folderId: 'f1' });
    expect((daemonCalls()[0]!.body as { inbox: string }).inbox).toBe('inbox');
  });

  it('refuses to mount the whole Files root, and a folder with no directory yet', async () => {
    vi.mocked(getSandboxByRef).mockResolvedValue(null);
    vi.mocked(diskPathForLtree).mockReturnValue('/data/files');
    expect(errorOf(await create.handler({ name: 'proj', inbox_folder_id: 'f1' }, ctx))).toMatch(
      /whole Files root is refused/,
    );
    vi.mocked(diskPathForLtree).mockReturnValue('/data/files/inbox');
    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));
    expect(errorOf(await create.handler({ name: 'proj', inbox_folder_id: 'f1' }, ctx))).toMatch(
      /no directory on disk yet/,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('sandbox_exec', () => {
  it("NEVER runs a command in a sandbox that is not the caller's", async () => {
    vi.mocked(getSandboxByRef).mockResolvedValue(null);
    const res = await exec.handler({ sandbox: 'scratch', command: 'rm -rf /files' }, ctx);
    expect(getSandboxByRef).toHaveBeenCalledWith('o1', 'scratch');
    expect(errorOf(res)).toMatch(/sandbox scratch not found/);
    expect(errorOf(res)).toMatch(/sandbox_list/);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(touchSandbox).not.toHaveBeenCalled();
  });

  it('rejects a blank command without calling the daemon', async () => {
    expect(errorOf(await exec.handler({ sandbox: 'scratch', command: '   ' }, ctx))).toMatch(
      /command is required/,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('runs the command by sandbox ID with the default timeout and marks the sandbox used', async () => {
    daemonReplies({ stdout: 'ok\n', stderr: '', exitCode: 0, durationMs: 12, cwd: '/files' });
    const res = await exec.handler({ sandbox: 'scratch', command: 'ls', cwd: '/files/x' }, ctx);
    expect(daemonCalls()[0]).toEqual({
      url: 'http://sandboxd.test/sandboxes/sb1/exec',
      method: 'POST',
      body: { command: 'ls', cwd: '/files/x', timeoutSeconds: 120 },
    });
    // A stopped sandbox was auto-started by the daemon; the row must follow.
    expect(setSandboxStatus).toHaveBeenCalledWith('sb1', 'running');
    expect(touchSandbox).toHaveBeenCalledWith('sb1');
    expect(outputOf(res)).toMatchObject({
      sandbox: 'scratch',
      exitCode: 0,
      stdout: 'ok\n',
      truncated: false,
    });
  });

  it('clamps the timeout to [1, 1800]', async () => {
    await exec.handler({ sandbox: 'scratch', command: 'x', timeout_seconds: 99_999 }, ctx);
    await exec.handler({ sandbox: 'scratch', command: 'x', timeout_seconds: -5 }, ctx);
    expect(daemonCalls().map((c) => (c.body as { timeoutSeconds: number }).timeoutSeconds)).toEqual(
      [1800, 1],
    );
  });

  it('returns a non-zero exit as a RESULT, not an error, and announces truncation', async () => {
    daemonReplies({ stdout: 'y'.repeat(70 * 1024), stderr: 'boom', exitCode: 2, timedOut: false });
    const res = await exec.handler({ sandbox: 'scratch', command: 'false' }, ctx);
    const out = outputOf(res);
    expect(out.exitCode).toBe(2);
    expect(out.truncated).toBe(true);
    expect(String(out.stdout)).toMatch(/\[truncated \d+ chars\]$/);
  });

  it('leaves the row alone when the daemon refused', async () => {
    daemonReplies({ error: 'container exited' }, false);
    expect(errorOf(await exec.handler({ sandbox: 'scratch', command: 'x' }, ctx))).toBe(
      'container exited',
    );
    expect(setSandboxStatus).not.toHaveBeenCalled();
    expect(touchSandbox).not.toHaveBeenCalled();
  });
});

describe('sandbox_stop', () => {
  it("calls no daemon for a sandbox that is not the caller's", async () => {
    vi.mocked(getSandboxByRef).mockResolvedValue(null);
    expect(errorOf(await stop.handler({ sandbox: 'ghost' }, ctx))).toMatch(/not found/);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(setSandboxStatus).not.toHaveBeenCalled();
  });

  it('stops by id and records the status only after the daemon agreed', async () => {
    daemonReplies({});
    const res = await stop.handler({ sandbox: 'scratch' }, ctx);
    expect(daemonCalls()[0]).toMatchObject({
      url: 'http://sandboxd.test/sandboxes/sb1/stop',
      method: 'POST',
    });
    expect(setSandboxStatus).toHaveBeenCalledWith('sb1', 'stopped');
    expect(outputOf(res)).toEqual({ sandbox: 'scratch', status: 'stopped' });
  });

  it('does not mark a sandbox stopped when the daemon refused', async () => {
    daemonReplies({ error: 'busy' }, false);
    expect(errorOf(await stop.handler({ sandbox: 'scratch' }, ctx))).toBe('busy');
    // Lying in the row would make sandbox_list say "stopped" for a container
    // still burning memory.
    expect(setSandboxStatus).not.toHaveBeenCalled();
  });
});

describe('sandbox_autostart', () => {
  it("calls no daemon for a sandbox that is not the caller's", async () => {
    vi.mocked(getSandboxByRef).mockResolvedValue(null);
    expect(errorOf(await autostart.handler({ sandbox: 'ghost', command: 'x' }, ctx))).toMatch(
      /not found/,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('stores the trimmed wake command and echoes the script the daemon wrote', async () => {
    daemonReplies({ wake: '/files/.wake.sh' });
    const res = await autostart.handler(
      { sandbox: 'scratch', command: ' sh /files/start.sh ' },
      ctx,
    );
    expect(daemonCalls()[0]).toEqual({
      url: 'http://sandboxd.test/sandboxes/sb1/autostart',
      method: 'POST',
      body: { command: 'sh /files/start.sh' },
    });
    expect(outputOf(res)).toEqual({
      sandbox: 'scratch',
      wakeCommand: 'sh /files/start.sh',
      script: '/files/.wake.sh',
    });
  });

  it('clears the hook when called with no command, and says so', async () => {
    daemonReplies({});
    const res = await autostart.handler({ sandbox: 'scratch' }, ctx);
    // An empty command IS the clear; the daemon must receive it, not be skipped.
    expect(daemonCalls()[0]!.body).toEqual({ command: '' });
    expect(outputOf(res)).toEqual({ sandbox: 'scratch', wakeCommand: null, cleared: true });
  });
});

describe('sandbox_export', () => {
  const TGZ = Buffer.from('tgz-bytes');

  it('refuses a raw export of a directory before calling the daemon', async () => {
    expect(errorOf(await exportTool.handler({ sandbox: 'scratch', raw: true }, ctx))).toMatch(
      /raw export needs `path` to name a single file/,
    );
    expect(
      errorOf(await exportTool.handler({ sandbox: 'scratch', raw: true, path: 'out/' }, ctx)),
    ).toMatch(/single file/);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(upsertFile).not.toHaveBeenCalled();
  });

  it('archives a subpath into files/sandbox-exports under the owner', async () => {
    daemonReplies({}, true, TGZ);
    vi.mocked(folderByPath).mockResolvedValue(null);
    const res = await exportTool.handler({ sandbox: 'scratch', path: 'myapi' }, ctx);
    expect(daemonCalls()[0]).toEqual({
      url: 'http://sandboxd.test/sandboxes/sb1/export',
      method: 'POST',
      body: { path: 'myapi', raw: false },
    });
    // The exports folder is created lazily when missing.
    expect(createFolder).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'o1', parentPath: 'files', slug: 'sandbox-exports' }),
    );
    expect(upsertFile).toHaveBeenCalledWith({
      ownerId: 'o1',
      parentPath: 'files.sandbox_exports',
      filename: 'scratch-myapi.tgz',
      bytes: expect.any(Buffer),
      overwrite: true,
    });
    expect(touchSandbox).toHaveBeenCalledWith('sb1');
    expect(outputOf(res)).toEqual({
      exported: 'myapi',
      file: 'files/sandbox-exports/scratch-myapi.tgz',
      nodeId: 'node-1',
      sizeBytes: TGZ.length,
    });
  });

  it('names a raw export after the file itself, and normalises an archive name to .tgz', async () => {
    daemonReplies({}, true, TGZ);
    await exportTool.handler({ sandbox: 'scratch', path: 'out/report.pdf', raw: true }, ctx);
    await exportTool.handler({ sandbox: 'scratch', path: 'out', filename: 'bundle' }, ctx);
    const names = vi.mocked(upsertFile).mock.calls.map(([a]) => a.filename);
    expect(names).toEqual(['report.pdf', 'bundle.tgz']);
    expect(daemonCalls()[0]!.body).toEqual({ path: 'out/report.pdf', raw: true });
  });

  it('writes nothing to Files when the daemon refused', async () => {
    daemonReplies({ error: 'path too large' }, false);
    expect(errorOf(await exportTool.handler({ sandbox: 'scratch', path: 'huge' }, ctx))).toBe(
      'path too large',
    );
    expect(upsertFile).not.toHaveBeenCalled();
    expect(touchSandbox).not.toHaveBeenCalled();
  });
});

describe('sandbox_import', () => {
  const FILE = '22222222-3333-4444-8555-666666666666';

  it('resolves the sandbox first, so a foreign one never reads the file', async () => {
    vi.mocked(getSandboxByRef).mockResolvedValue(null);
    expect(errorOf(await importTool.handler({ sandbox: 'ghost', file_id: FILE }, ctx))).toMatch(
      /sandbox ghost not found/,
    );
    expect(readFileById).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('reads the file under the owner and reports a miss before any upload', async () => {
    vi.mocked(readFileById).mockResolvedValue(null);
    const res = await importTool.handler({ sandbox: 'scratch', file_id: FILE }, ctx);
    expect(readFileById).toHaveBeenCalledWith({ ownerId: 'o1', fileId: FILE });
    expect(errorOf(res)).toMatch(/file .* not found/);
    expect(errorOf(res)).toMatch(/file_list/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('streams the bytes to the daemon with the destination on the query string', async () => {
    daemonReplies({ path: '/files/data/reg.accdb', sizeBytes: 5 });
    const res = await importTool.handler(
      { sandbox: 'scratch', file_id: FILE, path: 'data/reg.accdb' },
      ctx,
    );
    const [call] = daemonCalls();
    expect(call!.url).toBe('http://sandboxd.test/sandboxes/sb1/import?path=data%2Freg.accdb');
    expect(call!.method).toBe('POST');
    // Raw bytes, not JSON: base64 through a shell is what this tool exists to avoid.
    expect(Buffer.from(call!.body as Uint8Array).toString()).toBe('bytes');
    expect(touchSandbox).toHaveBeenCalledWith('sb1');
    expect(outputOf(res)).toEqual({
      imported: 'reg.accdb',
      path: '/files/data/reg.accdb',
      sizeBytes: 5,
      sandbox: 'scratch',
    });
  });

  it("defaults the destination to the file's own name", async () => {
    daemonReplies({ path: '/files/reg.accdb' });
    await importTool.handler({ sandbox: 'scratch', file_id: FILE }, ctx);
    expect(daemonCalls()[0]!.url).toMatch(/\?path=reg\.accdb$/);
  });
});

describe('sandbox_publish', () => {
  it('rejects a bad group slug before the daemon or the vault is touched', async () => {
    const res = await publish.handler(
      { sandbox: 'scratch', port: 8000, group_slug: 'Bad Slug' },
      ctx,
    );
    expect(errorOf(res)).toMatch(/group_slug 'Bad Slug' is invalid/);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(setApiKey).not.toHaveBeenCalled();
  });

  it('publishes the port, vaults the proxy token under the owner, and creates the group', async () => {
    daemonReplies({});
    const res = await publish.handler({ sandbox: 'scratch', port: 8000 }, ctx);
    expect(daemonCalls()[0]).toEqual({
      url: 'http://sandboxd.test/sandboxes/sb1/publish',
      method: 'POST',
      body: { port: 8000 },
    });
    expect(setApiKey).toHaveBeenCalledWith('o1', 'sandboxd', 'proxy', 'tok');
    expect(insert.values).toHaveBeenCalledWith({
      ownerId: 'o1',
      slug: 'sbx-scratch',
      name: 'Sandbox: scratch',
      description: expect.stringContaining("sandbox 'scratch' (port 8000)"),
      toolSlugs: [],
      integration: {
        service: 'sandbox-scratch',
        baseUrl: 'http://sandboxd.test/svc/sb1/8000',
        secretRef: 'sandboxd/proxy',
        authTemplate: { headers: { Authorization: 'Bearer {{secret:sandboxd/proxy}}' } },
      },
    });
    expect(dbmod.db.update).not.toHaveBeenCalled();
    expect(outputOf(res)).toMatchObject({
      group: 'sbx-scratch',
      baseUrl: 'http://sandboxd.test/svc/sb1/8000',
      port: 8000,
    });
  });

  it('scopes the group lookup to the caller, and the in-place update to the found row', async () => {
    // Drop `eq(toolGroups.ownerId, ...)` and re-publishing a sandbox would
    // repoint ANOTHER owner's group at this brain's proxy URL and token.
    daemonReplies({});
    selectRows = [{ id: 'tg1' }];
    await publish.handler({ sandbox: 'scratch', port: 9000, group_slug: 'calc' }, ctx);
    expect(paramsOf(selectWheres[0])).toEqual(expect.arrayContaining(['o1', 'calc']));
    expect(paramsOf(updateWheres[0])).toContain('tg1');
  });

  it('updates an existing group in place, keeping its authored tools', async () => {
    daemonReplies({});
    selectRows = [{ id: 'tg1' }];
    await publish.handler(
      { sandbox: 'scratch', port: 9000, group_slug: 'calc', description: 'calc API' },
      ctx,
    );
    expect(update.set).toHaveBeenCalledWith({
      integration: expect.objectContaining({ baseUrl: 'http://sandboxd.test/svc/sb1/9000' }),
      description: 'calc API',
      updatedAt: expect.any(Date),
    });
    // No toolSlugs in the update: re-publishing on a new port must not wipe
    // the endpoints already authored into the group.
    expect(update.set.mock.calls[0]![0]).not.toHaveProperty('toolSlugs');
    expect(dbmod.db.insert).not.toHaveBeenCalled();
  });

  it('vaults nothing and writes no group when the daemon refused', async () => {
    daemonReplies({ error: 'port not listening' }, false);
    expect(errorOf(await publish.handler({ sandbox: 'scratch', port: 8000 }, ctx))).toBe(
      'port not listening',
    );
    expect(setApiKey).not.toHaveBeenCalled();
    expect(dbmod.db.insert).not.toHaveBeenCalled();
    expect(dbmod.db.update).not.toHaveBeenCalled();
  });
});
