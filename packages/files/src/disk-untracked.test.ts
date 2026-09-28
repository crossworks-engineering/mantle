import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let root: string;
let prevRoot: string | undefined;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mantle-untracked-'));
  prevRoot = process.env.MANTLE_FILES_ROOT;
  process.env.MANTLE_FILES_ROOT = root;
});
afterAll(async () => {
  if (prevRoot === undefined) delete process.env.MANTLE_FILES_ROOT;
  else process.env.MANTLE_FILES_ROOT = prevRoot;
  await rm(root, { recursive: true, force: true });
});

const disk = () => import('./disk');

describe('isDiskChaff', () => {
  it('matches OS and editor chaff only', async () => {
    const { isDiskChaff } = await disk();
    for (const n of ['._sermon.md', '.DS_Store', 'notes.md~', '.notes.md.swp', 'x.swx', 'a.tmp', '#a.md#']) {
      expect(isDiskChaff(n), n).toBe(true);
    }
    for (const n of ['sermon.md', 'bible.epub', 'report.docx', 'archive.zip']) {
      expect(isDiskChaff(n), n).toBe(false);
    }
  });
});

describe('untrackedFilesOnDisk', () => {
  it('finds real files at any depth and skips chaff', async () => {
    const { untrackedFilesOnDisk } = await disk();
    const dir = path.join(root, 'church');
    await mkdir(path.join(dir, 'sermons'), { recursive: true });
    await writeFile(path.join(dir, '._sermons'), 'x');
    await writeFile(path.join(dir, 'sermons', '._a.md'), 'x');
    await writeFile(path.join(dir, 'sermons', '.DS_Store'), 'x');
    expect(await untrackedFilesOnDisk('files.church')).toEqual([]);

    await writeFile(path.join(dir, 'sermons', 'the-tree-of-knowledge.md'), 'real sermon');
    expect(await untrackedFilesOnDisk('files.church')).toEqual([
      path.join('sermons', 'the-tree-of-knowledge.md'),
    ]);
  });

  it('caps the list and tolerates a folder missing on disk', async () => {
    const { untrackedFilesOnDisk } = await disk();
    const dir = path.join(root, 'many');
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 8; i++) await writeFile(path.join(dir, `f${i}.md`), 'x');
    expect(await untrackedFilesOnDisk('files.many', 3)).toHaveLength(3);
    expect(await untrackedFilesOnDisk('files.not_there')).toEqual([]);
    expect(await untrackedFilesOnDisk('pages.x')).toEqual([]);
  });
});
