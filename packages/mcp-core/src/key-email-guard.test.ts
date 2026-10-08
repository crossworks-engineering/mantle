/**
 * A key reaches email only with the Search area (access matrix M4). On
 * /api/mcp an admin key limited to Files gets the Files tools, and before
 * one runs, a file id, folder id or folder path that is (or holds) an email
 * attachment refuses the call. A key with Search, or with every area, runs
 * the tool as before. The attachment lookup is pinned by
 * packages/files/src/email-attachments.db.test.ts; this drives the real
 * registration path against a capturing fake server.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const MAIL = '33333333-3333-4333-8333-333333333333';
const PLAIN = '22222222-2222-4222-8222-222222222222';

const files = vi.hoisted(() => ({
  reachesEmailAttachment: vi.fn(
    async (_o: string, ref: { id?: string; path?: string }) =>
      ref.id === MAIL || (ref.path ?? '').startsWith('inbox'),
  ),
  fileById: vi.fn(async ({ fileId }: { fileId: string }) => ({ id: fileId })),
}));
vi.mock('@mantle/files', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...files,
}));

import { KEY_EMAIL_REFUSAL, keyEmailGuard } from './key-email-guard';
import { keyAreasReachEmail } from './key-scope';
import { registerPreparedTools, type McpCaller } from './login-surface';

type Cb = (
  args: Record<string, unknown>,
  extra: unknown,
) => Promise<{
  isError?: boolean;
  content: { text: string }[];
}>;

function toolsFor(areas: readonly string[] | null): Map<string, Cb> {
  const out = new Map<string, Cb>();
  const fakeServer = {
    registerTool: (name: string, _config: unknown, cb: Cb) => void out.set(name, cb),
  };
  const caller: McpCaller = {
    role: 'admin',
    anchorId: 'owner-1',
    loginId: 'login-1',
    via: 'key',
    write: false,
    areas,
  };
  registerPreparedTools(fakeServer as never, { kind: 'owner', caller });
  return out;
}

beforeEach(() => vi.clearAllMocks());

describe('a key without Search and email attachments on MCP', () => {
  it('only Search or every area reaches email', () => {
    expect(keyAreasReachEmail(null)).toBe(true);
    expect(keyAreasReachEmail(['files', 'search'])).toBe(true);
    expect(keyAreasReachEmail(['files'])).toBe(false);
    expect(keyAreasReachEmail(['files', 'pages', 'notes'])).toBe(false);
  });

  it('refuses a Files tool on an attachment, before it runs', async () => {
    const fileGet = toolsFor(['files']).get('file_get')!;
    const res = await fileGet({ file_id: MAIL }, {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe(`Error: ${KEY_EMAIL_REFUSAL}`);
    expect(files.fileById).not.toHaveBeenCalled();
    const ok = await fileGet({ file_id: PLAIN }, {});
    expect(ok.isError).toBeUndefined();
    expect(files.fileById).toHaveBeenCalledTimes(1);
  });

  it('checks folder ids and folder paths too', async () => {
    const guard = keyEmailGuard('owner-1');
    expect(await guard('file_list', { parent_path: 'inbox.me_1a2b.attachments' })).toBe(
      KEY_EMAIL_REFUSAL,
    );
    expect(await guard('folder_copy', { folder_id: MAIL, dest_parent_path: 'files' })).toBe(
      KEY_EMAIL_REFUSAL,
    );
    expect(await guard('file_list', { parent_path: 'files.work' })).toBeNull();
    // Not a Files tool: the guard has nothing to say.
    expect(await guard('page_get', { id: MAIL })).toBeNull();
  });

  it('leaves a key with Search or every area alone', async () => {
    for (const areas of [null, ['files', 'search']]) {
      const res = await toolsFor(areas).get('file_get')!({ file_id: MAIL }, {});
      expect(res.isError).toBeUndefined();
    }
    expect(files.reachesEmailAttachment).not.toHaveBeenCalled();
  });
});
