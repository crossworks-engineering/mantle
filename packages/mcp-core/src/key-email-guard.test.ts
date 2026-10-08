/**
 * A key reaches email only with the Search area (access matrix M4). On
 * /api/mcp an admin key limited to Files gets the Files tools: the lists
 * drop attachment rows and attachments folders, and any other Files tool
 * whose file id, folder id or folder path is (or holds) an email attachment
 * is refused before it runs. A key with Search, or with every area, runs
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
  emailAttachmentFolders: vi.fn(
    async (_o: string, paths: string[]) =>
      new Set(paths.filter((p) => p === 'inbox.me_1a2b.attachments')),
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

  it('checks folder ids and folder paths too, uploads and moves included', async () => {
    const { before } = keyEmailGuard('owner-1');
    expect(await before!('folder_copy', { folder_id: MAIL, dest_parent_path: 'files' })).toBe(
      KEY_EMAIL_REFUSAL,
    );
    expect(await before!('file_upload', { parent_path: 'inbox.me_1a2b.attachments' })).toBe(
      KEY_EMAIL_REFUSAL,
    );
    expect(await before!('file_move', { file_id: PLAIN, dest_path: 'inbox.me_1a2b' })).toBe(
      KEY_EMAIL_REFUSAL,
    );
    expect(await before!('file_upload', { parent_path: 'files.work' })).toBeNull();
    // Not a Files tool: the guard has nothing to say.
    expect(await before!('page_get', { id: MAIL })).toBeNull();
  });

  it('lists drop attachment rows instead of refusing the call', async () => {
    const { before, after } = keyEmailGuard('owner-1');
    expect(await before!('file_list', { parent_path: 'inbox.me_1a2b.attachments' })).toBeNull();
    const fileRows = [
      { id: PLAIN, parentPath: 'files.work' },
      { id: MAIL, parentPath: 'inbox.me_1a2b.attachments' },
    ];
    const listed = await after!(
      'file_list',
      {},
      {
        content: [{ type: 'text', text: JSON.stringify(fileRows) }],
      },
    );
    expect(JSON.parse(listed.content![0]!.text!)).toEqual([fileRows[0]]);
    const folderRows = [{ path: 'inbox.me_1a2b' }, { path: 'inbox.me_1a2b.attachments' }];
    const folders = await after!(
      'folder_list',
      {},
      {
        content: [{ type: 'text', text: JSON.stringify(folderRows) }],
      },
    );
    expect(JSON.parse(folders.content![0]!.text!)).toEqual([folderRows[0]]);
    // An error or a non-list answer passes through untouched.
    const err = { content: [{ type: 'text', text: 'Error: x' }], isError: true };
    expect(await after!('file_list', {}, err)).toBe(err);
  });

  it('leaves a key with Search or every area alone', async () => {
    for (const areas of [null, ['files', 'search']]) {
      const res = await toolsFor(areas).get('file_get')!({ file_id: MAIL }, {});
      expect(res.isError).toBeUndefined();
    }
    expect(files.reachesEmailAttachment).not.toHaveBeenCalled();
  });
});
