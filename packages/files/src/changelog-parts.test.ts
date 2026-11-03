import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { changelogParts, compareVersionsDesc } from './changelog-parts';

const SAMPLE = [
  '# Changelog',
  '',
  'Intro text above the releases.',
  '',
  '## v0.500.3: one entry',
  '',
  '- **Fixed:** a thing.',
  '',
  '## v0.400.70',
  '',
  '### the first entry',
  '',
  '- **Added:** one.',
  '',
  '### the second entry',
  '',
  '```md',
  '## v9.9.9: inside a fence, not a release',
  '```',
  '',
  '## 0.239.13: the older form',
  '',
  'Body.',
  '',
].join('\n');

describe('changelogParts', () => {
  it('splits on both heading forms and leaves the intro out', () => {
    const parts = changelogParts(SAMPLE);
    expect(parts.map((p) => p.version)).toEqual(['0.500.3', '0.400.70', '0.239.13']);
    expect(parts[0]!.markdown).toBe('## v0.500.3: one entry\n\n- **Fixed:** a thing.');
    expect(parts.some((p) => p.markdown.includes('Intro text'))).toBe(false);
  });

  it('keeps the ### entries of a bare version heading in its part', () => {
    const md = changelogParts(SAMPLE)[1]!.markdown;
    expect(md.startsWith('## v0.400.70\n')).toBe(true);
    expect(md).toContain('### the first entry');
    expect(md).toContain('### the second entry');
  });

  it('reads a heading inside a code fence as text', () => {
    const parts = changelogParts(SAMPLE);
    expect(parts.map((p) => p.version)).not.toContain('9.9.9');
    expect(parts[1]!.markdown).toContain('## v9.9.9: inside a fence');
  });

  it('gives a version written twice as two parts, in file order', () => {
    const raw = '## v1.0.0: a\n\nA\n\n## v1.0.0: b\n\nB\n';
    expect(changelogParts(raw).map((p) => p.markdown)).toEqual([
      '## v1.0.0: a\n\nA',
      '## v1.0.0: b\n\nB',
    ]);
  });

  it('takes CRLF line ends and a file with no release', () => {
    expect(changelogParts('## v1.2.3: x\r\n\r\nBody\r\n')).toEqual([
      { version: '1.2.3', markdown: '## v1.2.3: x\n\nBody' },
    ]);
    expect(changelogParts('# Changelog\n\nNothing yet.\n')).toEqual([]);
  });

  it('does not take a longer number or a fourth part as a version', () => {
    expect(changelogParts('## v1.2.3.4\n\n## v1.2.34x\n')).toEqual([]);
  });
});

describe('compareVersionsDesc', () => {
  it('sorts by number, newest first', () => {
    expect(['0.9.0', '0.500.3', '0.10.1', '0.500.10'].sort(compareVersionsDesc)).toEqual([
      '0.500.10',
      '0.500.3',
      '0.10.1',
      '0.9.0',
    ]);
  });
});

describe('the real CHANGELOG.md', () => {
  const raw = fs.readFileSync(path.resolve(__dirname, '../../../CHANGELOG.md'), 'utf8');
  const versions = changelogParts(raw).map((p) => p.version);

  it('has releases, and its top heading is its newest version', () => {
    expect(versions.length).toBeGreaterThan(0);
    expect([...versions].sort(compareVersionsDesc)[0]).toBe(versions[0]);
  });
});
