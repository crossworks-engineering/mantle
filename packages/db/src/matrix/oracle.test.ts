/**
 * The oracle (./oracle.ts) against the guide's own sentences
 * (docs/workspaces.md), so a slip in it shows here before it can make the
 * grid agree with a wrong database.
 */
import { describe, expect, it } from 'vitest';
import {
  ORACLE_ROLES,
  expectedReadCreate,
  expectedFolderCount,
  guideKindClass,
  guideWorkspaceKinds,
} from './oracle';

const at = (placement: 'root' | 'folder') => ({ surface: 'sql' as const, placement });

describe('the access oracle', () => {
  it('"Folders, files, notes, pages, tables, apps, formulas, drawings, tasks, events, Recall maps and canvases"', () => {
    expect(guideWorkspaceKinds().sort()).toEqual(
      [
        'branch',
        'file',
        'note',
        'page',
        'table',
        'app',
        'formula',
        'draw',
        'task',
        'event',
        'recall',
        'present',
      ].sort(),
    );
    expect(guideKindClass('telegram_message')).toBe('conversation');
    expect(guideKindClass('journal')).toBe('admin_only');
    expect(guideKindClass('contact')).toBe('admin_only');
  });

  it('"Read the item: to be a user of a workspace it is granted to"', () => {
    for (const p of ['root', 'folder'] as const) {
      expect(expectedReadCreate(at(p), 'homeModerator', 'page', 'read')).toEqual({ allow: true });
      expect(expectedReadCreate(at(p), 'writeGrant', 'task', 'read')).toEqual({ allow: true });
      expect(expectedReadCreate(at(p), 'readGrant', 'recall', 'read')).toEqual({ allow: true });
      expect(expectedReadCreate(at(p), 'outsider', 'note', 'read')).toMatchObject({ allow: false });
    }
  });

  it('"Being an Admin user is management, not reading"', () => {
    expect(expectedReadCreate(at('root'), 'admin', 'page', 'read')).toMatchObject({ allow: false });
    expect(expectedReadCreate(at('root'), 'owner', 'event', 'read')).toMatchObject({
      allow: false,
    });
  });

  it('the home rule: a folder you may edit, else private, Admin users land in Admin', () => {
    expect(expectedReadCreate(at('folder'), 'homeModerator', 'file', 'create')).toEqual({
      allow: true,
      lands: 'home',
    });
    expect(expectedReadCreate(at('folder'), 'writeGrant', 'formula', 'create')).toEqual({
      allow: true,
      lands: 'home',
    });
    expect(expectedReadCreate(at('folder'), 'readGrant', 'page', 'create')).toMatchObject({
      allow: false,
    });
    expect(expectedReadCreate(at('folder'), 'owner', 'page', 'create')).toMatchObject({
      allow: false,
    });
    for (const role of ['homeModerator', 'writeGrant', 'readGrant', 'outsider'] as const) {
      expect(expectedReadCreate(at('root'), role, 'task', 'create')).toEqual({
        allow: true,
        lands: 'private',
      });
    }
    expect(expectedReadCreate(at('root'), 'admin', 'task', 'create')).toEqual({
      allow: true,
      lands: 'admin',
    });
  });

  it('answers n/a outside its slice', () => {
    for (const role of ORACLE_ROLES) {
      expect(expectedReadCreate(at('root'), role, 'journal', 'read')).toHaveProperty('na');
    }
  });
});

describe('the folder-count oracle', () => {
  const shows = (items: number, folders: number) => ({ shows: true, items, folders });

  it('"A folder\'s counts are yours": only what you read in your scope, the folder always shows', () => {
    for (const caller of ['member', 'adminUser', 'adminUserInHome'] as const) {
      expect(expectedFolderCount('oneOfThree', caller, 'S')).toEqual(shows(1, 0));
    }
    // An Admin user reads only what its workspaces read.
    expect(expectedFolderCount('noneShared', 'adminUser', 'all')).toEqual(shows(0, 0));
    expect(expectedFolderCount('noneShared', 'member', 'S')).toEqual(shows(0, 0));
    // A user of H reads all three, and the subfolder.
    expect(expectedFolderCount('noneShared', 'adminUserInHome', 'all')).toEqual(shows(3, 1));
  });

  it('"The picked workspace does not narrow the folders"', () => {
    expect(expectedFolderCount('noneShared', 'adminUserInHome', 'S')).toEqual(shows(0, 1));
  });

  it('"You pick only a workspace you are in, Admin users too"', () => {
    expect(expectedFolderCount('noneShared', 'adminUserInHome', 'H')).toEqual(shows(3, 1));
    for (const caller of ['member', 'adminUser'] as const) {
      expect(expectedFolderCount('oneOfThree', caller, 'H')).toMatchObject({
        refused: expect.any(String),
      });
    }
  });
});
