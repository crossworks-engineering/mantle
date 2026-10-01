/**
 * The launcher folders built from folder rows and the apps a reader may run
 * (./app-folders.ts), without a database: a folder is answered only when it
 * leads to one of those apps. The level rule and the real roles are proven
 * on Postgres in ./app-folders.viewer.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { buildAppLauncherFolders, type AppFolderRow } from './app-folders';

const row = (id: string, path: string, data: Record<string, unknown> | null = null) =>
  ({ id, path, title: `Folder ${id}`, data }) satisfies AppFolderRow;

describe('launcher folders', () => {
  it('puts an app in its folder, and leaves a root app in no folder', () => {
    const folders = buildAppLauncherFolders(
      [row('f1', 'apps.tools', { icon: 'lucide:wrench', color: 'teal' })],
      [
        { id: 'a1', path: 'apps.tools' },
        { id: 'a2', path: 'apps' },
      ],
    );
    expect(folders).toEqual([
      {
        id: 'f1',
        name: 'Folder f1',
        icon: 'lucide:wrench',
        color: 'teal',
        parentId: null,
        appIds: ['a1'],
      },
    ]);
  });

  it('keeps the folders on the way to an app, each under its parent', () => {
    const folders = buildAppLauncherFolders(
      [row('top', 'apps.a'), row('mid', 'apps.a.b'), row('leaf', 'apps.a.b.c')],
      [{ id: 'a1', path: 'apps.a.b.c' }],
    );
    expect(folders.map((f) => [f.id, f.parentId, f.appIds])).toEqual([
      ['top', null, []],
      ['mid', 'top', []],
      ['leaf', 'mid', ['a1']],
    ]);
  });

  it('drops a folder row that leads to no app', () => {
    const folders = buildAppLauncherFolders(
      [row('used', 'apps.a'), row('side', 'apps.a.side'), row('other', 'apps.z')],
      [{ id: 'a1', path: 'apps.a' }],
    );
    expect(folders.map((f) => f.id)).toEqual(['used']);
  });

  it('keeps the order of the rows and of the apps', () => {
    const folders = buildAppLauncherFolders(
      [row('second', 'apps.b'), row('first', 'apps.a')],
      [
        { id: 'a2', path: 'apps.a' },
        { id: 'a1', path: 'apps.a' },
        { id: 'a3', path: 'apps.b' },
      ],
    );
    expect(folders.map((f) => [f.id, f.appIds])).toEqual([
      ['second', ['a3']],
      ['first', ['a2', 'a1']],
    ]);
  });

  it('lifts an app whose folder has no row to the deepest folder that has', () => {
    // `apps.a.gone` has no row: the app shows in `apps.a`. A chain with no
    // row at its top leaves the app at the top level, and names no folder.
    const folders = buildAppLauncherFolders(
      [row('a', 'apps.a'), row('deep', 'apps.lost.deep')],
      [
        { id: 'a1', path: 'apps.a.gone' },
        { id: 'a2', path: 'apps.lost.deep' },
      ],
    );
    expect(folders.map((f) => [f.id, f.appIds])).toEqual([['a', ['a1']]]);
  });

  it('reads no folder for a path outside the Apps tree', () => {
    expect(buildAppLauncherFolders([row('n', 'notes.a')], [{ id: 'a1', path: 'notes.a' }])).toEqual(
      [],
    );
  });

  it('answers no icon or colour it does not know', () => {
    const [folder] = buildAppLauncherFolders(
      [row('f', 'apps.a', { icon: 'chart-bar', color: 'mauve' })],
      [{ id: 'a1', path: 'apps.a' }],
    );
    expect(folder).toMatchObject({ icon: null, color: null });
  });
});
