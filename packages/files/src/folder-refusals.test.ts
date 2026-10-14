/**
 * The Files refusals a person must read (A10 part 2 fix round 1, M2). The
 * folder routes (`/api/files/folders`, `/api/files/folders/:id`,
 * `/api/files/files/:id`) answered every error of these calls 400 with its
 * message before fold 2; fold 2 made a plain Error the opaque 500, so each
 * refusal here is an InputError now: the one table answers it 400 with the
 * same message, byte for byte. The database is stood in by the row the
 * lookup finds.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { domainErrorAnswer } from '@mantle/std';

const h = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => h.rows }) }) }),
  },
}));

const { createFolder, renameFolderById } = await import('./ops/folders');
const { setIndexingMode } = await import('./indexing');
const { assertFilesFolderDepth, notAFilesFolder } = await import('./paths');

const OWNER = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';

/** What the route answers for the error `fn` throws (the main route said
 *  `400 { error: message }`). */
async function answerOf(fn: () => Promise<unknown> | unknown) {
  let thrown: unknown;
  try {
    await fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  const a = domainErrorAnswer(thrown);
  return a && { status: a.status, body: a.body };
}

const folder = (path: string, data: Record<string, unknown> | null = null) => ({
  id: ID,
  ownerId: OWNER,
  type: 'branch',
  path,
  title: 'x',
  data,
});

beforeEach(() => {
  h.rows = [];
});

describe('renameFolderById: the refusals answer 400 with their text, as on main', () => {
  it('the files root', async () => {
    h.rows = [folder('files')];
    expect(
      await answerOf(() => renameFolderById({ ownerId: OWNER, folderId: ID, newSlug: 'y' })),
    ).toEqual({ status: 400, body: { error: 'renameFolderById: cannot rename the files root' } });
  });

  it('a folder of another kind', async () => {
    h.rows = [folder('pages.notes')];
    expect(
      await answerOf(() => renameFolderById({ ownerId: OWNER, folderId: ID, newSlug: 'y' })),
    ).toEqual({
      status: 400,
      body: {
        error:
          "renameFolderById: 'pages.notes' is not a Files folder; organise another kind's folders with " +
          'tree_folder_update and tree_folder_delete (or its own screen)',
      },
    });
  });

  it('a folder Mantle makes (its name is fixed)', async () => {
    h.rows = [folder('files.auto_filed', { system: true })];
    expect(
      await answerOf(() => renameFolderById({ ownerId: OWNER, folderId: ID, newSlug: 'y' })),
    ).toEqual({
      status: 400,
      body: { error: 'renameFolderById: this folder is made by Mantle; its name is fixed' },
    });
  });

  it('a name with nothing a folder can be called', async () => {
    h.rows = [folder('files.a')];
    expect(
      await answerOf(() => renameFolderById({ ownerId: OWNER, folderId: ID, newSlug: '   ' })),
    ).toEqual({ status: 400, body: { error: "renameFolderById: invalid name '   '" } });
  });
});

describe('createFolder: the refusals answer 400 with their text, as on main', () => {
  it('a parent outside the files root, a bad slug, a parent not there, too deep', async () => {
    const make = (parentPath: string, slug: string) => () =>
      createFolder({ ownerId: OWNER, parentPath, slug });
    expect(await answerOf(make('pages', 'a'))).toEqual({
      status: 400,
      body: { error: "createFolder: parent 'pages' is outside the files root" },
    });
    expect(await answerOf(make('files', '   '))).toEqual({
      status: 400,
      body: { error: "createFolder: invalid slug '   '" },
    });
    h.rows = [];
    expect(await answerOf(make('files.gone', 'a'))).toEqual({
      status: 400,
      body: { error: "createFolder: parent folder 'files.gone' not found" },
    });
    expect((await answerOf(make('files.a.b.c', 'd')))?.status).toBe(400);
  });
});

describe('the Files helpers and the indexing switch', () => {
  it('notAFilesFolder and the depth check are InputErrors (400, their text)', async () => {
    expect(await answerOf(() => assertFilesFolderDepth('files.a.b.c.d', 'moveFolderById'))).toEqual(
      {
        status: 400,
        body: {
          error:
            "moveFolderById: 'files.a.b.c.d' is deeper than 3 folder levels; folders nest folder, subfolder, sub-subfolder",
        },
      },
    );
    const refusal = notAFilesFolder('copyFolderById', 'tables.x');
    expect(domainErrorAnswer(refusal)?.status).toBe(400);
  });

  it('setIndexingMode: a node not there, a node with no indexing flag', async () => {
    h.rows = [];
    expect(
      await answerOf(() => setIndexingMode({ ownerId: OWNER, nodeId: ID, mode: 'metadata' })),
    ).toEqual({ status: 400, body: { error: `setIndexingMode: node ${ID} not found` } });
    h.rows = [{ id: ID, type: 'page', data: {} }];
    const wrongKind = await answerOf(() =>
      setIndexingMode({ ownerId: OWNER, nodeId: ID, mode: 'metadata' }),
    );
    expect(wrongKind?.status).toBe(400);
    expect(String(wrongKind?.body.error)).toMatch(
      /^setIndexingMode: 'page' nodes don't carry an indexing flag/,
    );
  });
});
