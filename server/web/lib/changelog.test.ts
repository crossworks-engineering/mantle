import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getChangelogMarkdown,
  getLatestChangelogVersion,
  listChangelogVersions,
} from './changelog';

/**
 * The in-app Changelog reads CHANGELOG.md beside the docs root, and the old
 * docs/_changelog files for the versions CHANGELOG.md does not hold.
 */

const CHANGELOG = [
  '# Changelog',
  '',
  'Intro.',
  '',
  '## v0.500.3: the newest',
  '',
  '- **Fixed:** one.',
  '',
  '## v0.400.70',
  '',
  '### first entry',
  '',
  '- **Added:** two.',
  '',
  '### second entry',
  '',
  '```md',
  '## kept as text',
  '```',
  '',
  '## 0.232.35: in both sources',
  '',
  'From CHANGELOG.md.',
  '',
].join('\n');

let dir: string;
let before: string | undefined;

function write(rel: string, text: string) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-'));
  before = process.env.MANTLE_DOCS_ROOT;
  process.env.MANTLE_DOCS_ROOT = path.join(dir, 'docs');
  fs.mkdirSync(path.join(dir, 'docs'));
});

afterEach(() => {
  if (before === undefined) delete process.env.MANTLE_DOCS_ROOT;
  else process.env.MANTLE_DOCS_ROOT = before;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the in-app changelog', () => {
  it('lists CHANGELOG.md and the old files together, newest first; Latest is the top heading', async () => {
    write('CHANGELOG.md', CHANGELOG);
    write('docs/_changelog/0.232.35.md', '# 0.232.35\n\nFrom the old file.\n');
    write('docs/_changelog/0.99.0.md', '# 0.99.0\n\nOld.\n');
    write('docs/_changelog/not-a-version.md', 'skip');
    expect(await listChangelogVersions()).toEqual(['0.500.3', '0.400.70', '0.232.35', '0.99.0']);
    expect(await getLatestChangelogVersion()).toBe('0.500.3');
  });

  it('gives a one-entry release with its heading lifted to the top level', async () => {
    write('CHANGELOG.md', CHANGELOG);
    expect(await getChangelogMarkdown('0.500.3')).toBe(
      '# v0.500.3: the newest\n\n- **Fixed:** one.',
    );
  });

  it('gives a bare version heading with its ### entries as ##, code fences untouched', async () => {
    write('CHANGELOG.md', CHANGELOG);
    const md = await getChangelogMarkdown('0.400.70');
    expect(md).toContain('# v0.400.70\n');
    expect(md).toContain('\n## first entry\n');
    expect(md).toContain('\n## second entry\n');
    expect(md).toContain('```md\n## kept as text\n```');
  });

  it('reads a version in both sources from CHANGELOG.md, and an older one from its file', async () => {
    write('CHANGELOG.md', CHANGELOG);
    write('docs/_changelog/0.232.35.md', '# 0.232.35\n\nFrom the old file.\n');
    write('docs/_changelog/0.99.0.md', '# 0.99.0\n\nOld.\n');
    expect(await getChangelogMarkdown('0.232.35')).toContain('From CHANGELOG.md.');
    expect(await getChangelogMarkdown('0.99.0')).toBe('# 0.99.0\n\nOld.\n');
  });

  it('joins a version written twice, in file order', async () => {
    write('CHANGELOG.md', '## v1.0.0: a\n\nA\n\n## v1.0.0: b\n\nB\n');
    expect(await listChangelogVersions()).toEqual(['1.0.0']);
    expect(await getChangelogMarkdown('1.0.0')).toBe('# v1.0.0: a\n\nA\n\n# v1.0.0: b\n\nB');
  });

  it('works with only the old files, and with nothing at all', async () => {
    write('docs/_changelog/0.99.0.md', '# 0.99.0\n');
    expect(await getLatestChangelogVersion()).toBe('0.99.0');
    fs.rmSync(path.join(dir, 'docs', '_changelog'), { recursive: true });
    expect(await listChangelogVersions()).toEqual([]);
    expect(await getLatestChangelogVersion()).toBeNull();
  });

  it('refuses a version that is not x.y.z and answers null for one it does not hold', async () => {
    write('CHANGELOG.md', CHANGELOG);
    write('docs/x.md', 'outside');
    expect(await getChangelogMarkdown('../x')).toBeNull();
    expect(await getChangelogMarkdown('0.500.3/../../x')).toBeNull();
    expect(await getChangelogMarkdown('9.9.9')).toBeNull();
  });
});

describe('CHANGELOG.md in the server image', () => {
  // The reader looks beside MANTLE_DOCS_ROOT. In the image that is /app/docs,
  // and `COPY . .` puts CHANGELOG.md at /app: a .dockerignore line would
  // drop it there while every repo test still passes.
  const repo = path.resolve(__dirname, '../../..');

  it('is not left out of the build context', () => {
    const ignore = fs
      .readFileSync(path.join(repo, '.dockerignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    const drops = ignore.filter((l) => /^(\*\*\/)?(\*|CHANGELOG)(\.md|\*)?$/i.test(l));
    expect(drops, '.dockerignore drops CHANGELOG.md from the image').toEqual([]);
  });

  it('sits beside the docs root the compose file sets', () => {
    const compose = fs.readFileSync(path.join(repo, 'docker-compose.yml'), 'utf8');
    expect(compose).toMatch(/MANTLE_DOCS_ROOT: \/app\/docs\b/);
    expect(fs.readFileSync(path.join(repo, 'Dockerfile'), 'utf8')).toMatch(
      /^FROM deps AS server$/m,
    );
    expect(fs.existsSync(path.join(repo, 'CHANGELOG.md'))).toBe(true);
  });
});
