import { describe, expect, it } from 'vitest';
import { APP_GUIDE_TOOLS, findGuideSections, splitGuideSections } from './builtins-app-guide';

const guide = APP_GUIDE_TOOLS[0]!;
const call = (input: Record<string, unknown>) => guide.handler(input, { ownerId: 'owner-1' });

describe('splitGuideSections', () => {
  it('splits at ## headings, keeps ### inside, ignores ## in fenced code', () => {
    const md = [
      '# Title',
      'intro',
      '## One',
      'a',
      '### Sub',
      'b',
      '```md',
      '## not a heading',
      '```',
      '## Two',
      'c',
    ].join('\n');
    const s = splitGuideSections(md);
    expect(s.map((x) => x.heading)).toEqual(['One', 'Two']);
    expect(s[0]!.text).toContain('### Sub');
    expect(s[0]!.text).toContain('## not a heading');
  });

  it('matches headings ignoring case and punctuation', () => {
    const s = splitGuideSections('## The `@host` runtime bridge\nx\n## Per-app SQLite\ny');
    expect(findGuideSections(s, 'HOST').map((x) => x.heading)).toEqual([
      'The `@host` runtime bridge',
    ]);
    expect(findGuideSections(s, 'per app sqlite')).toHaveLength(1);
    expect(findGuideSections(s, '  ')).toEqual([]);
  });
});

describe('app_authoring_guide', () => {
  it('is a read-only MCP-only tool', () => {
    expect(guide.slug).toBe('app_authoring_guide');
    expect(guide.readOnly).toBe(true);
    expect(guide.mcpOnly).toBe(true);
  });

  it('returns the whole guide with no section', async () => {
    const res = await call({});
    expect(res.ok).toBe(true);
    const out = (res as { output: { guide: string } }).output;
    expect(out.guide).toContain('## Who is running the app');
  });

  it('returns the identity section, which names host.me() and the refused params', async () => {
    const res = await call({ section: 'Who is running the app' });
    expect(res.ok).toBe(true);
    const out = (res as { output: { section: string[]; text: string } }).output;
    expect(out.section).toEqual(['Who is running the app']);
    expect(out.text).toContain('await host.me()');
    expect(out.text).toContain(':host_me_kind');
    expect(out.text).toContain('refused');
  });

  it('lists the sections when none matches', async () => {
    const res = await call({ section: 'no such heading' });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain('Who is running the app');
  });
});
