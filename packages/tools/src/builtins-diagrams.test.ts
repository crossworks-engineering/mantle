import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The site profile is a file in the brain: stub the two reads it makes.
const files = vi.hoisted(() => ({ profile: null as null | string }));
vi.mock('@mantle/files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/files')>()),
  listFiles: vi.fn(async ({ parentPath }: { parentPath: string }) =>
    files.profile !== null && parentPath === 'files.diagrams.profiles'
      ? [{ id: 'f-pid', filename: 'pid.md' }]
      : [],
  ),
  readFileById: vi.fn(async () =>
    files.profile !== null ? { bytes: Buffer.from(files.profile, 'utf8') } : null,
  ),
}));
import {
  PROFILE_MAX_CHARS,
  DIAGRAM_PATTERNS,
  DIAGRAM_TOOLS,
  DIAGRAM_TYPES,
  dropSections,
  resolveDiagramType,
} from './builtins-diagrams';
// The access lists are views of the tool policy table, which the registry
// fills (A5): load it.
import './registry';

const [typesTool, guideTool] = DIAGRAM_TOOLS as [
  (typeof DIAGRAM_TOOLS)[0],
  (typeof DIAGRAM_TOOLS)[0],
];
const ctx = { ownerId: 'owner-1' };
const guide = async (input: Record<string, unknown>) => {
  const res = await guideTool.handler(input, ctx);
  if (!res.ok) throw new Error((res as { error: string }).error);
  return (res as { output: { guide: string } }).output.guide;
};

const GUIDES = path.resolve(__dirname, '../../../docs/diagram-guides');

/** The largest reply the tool may give (characters, about 4 per token). The
 *  biggest today is the line chart with the shared rules (about 75k); a refresh that
 *  grows past this should be a decision, not an accident. */
const MAX_GUIDE_CHARS = 80_000;

describe('dropSections', () => {
  const md = [
    '# Title',
    'intro',
    '## Keep',
    'a',
    '### Drop me',
    'b',
    '```md',
    '## Drop me too, but fenced',
    '```',
    '### Kept sub',
    'c',
    '## Drop me',
    'd',
    '## Last',
    'e',
  ].join('\n');

  it('drops a section up to the next heading of the same or a higher level', () => {
    const out = dropSections(md, ['drop me']);
    expect(out).toContain('intro');
    expect(out).toContain('### Kept sub');
    expect(out).not.toContain('\nb\n');
    expect(out).not.toContain('\nd\n');
    expect(out).toContain('## Last');
  });

  it('drops the intro on request and ignores fenced headings', () => {
    const out = dropSections(md, [], false);
    expect(out.startsWith('## Keep')).toBe(true);
    expect(dropSections(md, ['drop me too'])).toContain('## Drop me too, but fenced');
  });
});

describe('the type catalog', () => {
  it('has one row per guide file and a file per row', () => {
    const upstream = readdirSync(GUIDES).filter((f) => /^type-.+\.md$/.test(f));
    const mantle = readdirSync(path.join(GUIDES, 'mantle'))
      .filter((f) => /^type-.+\.md$/.test(f))
      .map((f) => `mantle/${f}`);
    expect(DIAGRAM_TYPES.map((t) => t.file).sort()).toEqual([...upstream, ...mantle].sort());
    expect(new Set(DIAGRAM_TYPES.map((t) => t.slug)).size).toBe(DIAGRAM_TYPES.length);
  });

  it('resolves slugs, aliases, names and file stems', () => {
    expect(resolveDiagramType('pid')?.slug).toBe('pid');
    expect(resolveDiagramType('P&ID')?.slug).toBe('pid');
    expect(resolveDiagramType('Bar chart')?.slug).toBe('bar');
    expect(resolveDiagramType('type-org-chart.md')?.slug).toBe('org-chart');
    expect(resolveDiagramType('State machine')?.slug).toBe('state');
    expect(resolveDiagramType('nope')).toBeNull();
  });
});

describe('diagram_types', () => {
  it('lists every type, pattern and import, read-only', async () => {
    expect(typesTool.readOnly).toBe(true);
    expect(guideTool.readOnly).toBe(true);
    const res = await typesTool.handler({}, ctx);
    expect(res.ok).toBe(true);
    const out = (
      res as { output: { types: { type: string }[]; patterns: unknown[]; imports: string[] } }
    ).output;
    expect(out.types).toHaveLength(DIAGRAM_TYPES.length);
    expect(out.types.map((t) => t.type)).toContain('pid');
    expect(out.patterns).toHaveLength(DIAGRAM_PATTERNS.length);
    expect(out.imports).toEqual(['mermaid', 'drawio', 'excalidraw']);
  });
});

describe('diagram_guide', () => {
  it('returns the medium rules, the shared rules and the type guide', async () => {
    const g = await guide({ type: 'bar' });
    expect(g).toContain('# Mantle medium rules');
    expect(g).toContain('## Tokens');
    expect(g).toContain('### 4px grid');
    expect(g).toContain('## Mandatory connector rules');
    expect(g).toContain('### Type ramp per size class');
    expect(g).toContain('# Bar');
    // Upstream's HTML-medium sections stay out.
    expect(g).not.toContain('## Customizing the skin');
    expect(g).not.toContain('## Summary Card Pattern');
    expect(g).not.toContain('## 1. Format');
    expect(g).not.toContain('assets/example-bar.html');
  });

  it('serves the Mantle P&ID guide', async () => {
    const g = await guide({ type: 'P&ID', shared: false });
    expect(g).toContain('# P&ID / process schematic');
    expect(g).toContain('First draft');
    expect(g).not.toContain('# Mantle medium rules');
  });

  it('adds one semantic pattern and an import guide on request', async () => {
    const g = await guide({
      type: 'data-flow',
      pattern: 'fan-in-queue',
      import: 'mermaid',
      shared: false,
    });
    expect(g).toContain('## 1. Fan-in queue');
    expect(g).not.toContain('## 2. Stage framework');
    expect(g).toContain('## Composition rules');
    expect(g).toContain('# Import');
    expect(g).toContain('## 5. Fidelity ledger');
  });

  it('says plainly when the brain keeps no site profile', async () => {
    files.profile = null;
    const res = await guideTool.handler({ type: 'pid', shared: false }, ctx);
    const out = (res as { output: { site_profile: string; guide: string } }).output;
    expect(out.site_profile).toContain('None');
    expect(out.site_profile).toContain('files/diagrams/profiles/pid.md');
    expect(out.guide).not.toContain('Site profile');
  });

  it("appends the brain's site profile last, and cuts a long one", async () => {
    files.profile = '# Site conventions\nLine numbers: AREA-SIZE-SERVICE-SEQ.';
    const res = await guideTool.handler({ type: 'pid', shared: false }, ctx);
    const out = (res as { output: { site_profile: string; guide: string } }).output;
    expect(out.site_profile).toContain('Found');
    expect(out.guide.trimEnd().endsWith('Line numbers: AREA-SIZE-SERVICE-SEQ.')).toBe(true);
    files.profile = 'x'.repeat(PROFILE_MAX_CHARS + 10);
    const long = await guideTool.handler({ type: 'pid', shared: false }, ctx);
    expect((long as { output: { site_profile: string } }).output.site_profile).toContain(
      'only its first',
    );
    files.profile = null;
  });

  it('names the valid types for an unknown one', async () => {
    const res = await guideTool.handler({ type: 'mindmap' }, ctx);
    expect(res.ok).toBe(false);
    const error = (res as { error: string }).error;
    expect(error).toContain("No diagram type 'mindmap'");
    expect(error).toContain('architecture');
    expect(error).toContain('pid');
    expect(error).toContain('diagram_types');
  });

  it('refuses an unknown pattern', async () => {
    const res = await guideTool.handler({ type: 'flowchart', pattern: 'nope' }, ctx);
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain('lifecycle-phase-map');
  });

  it('keeps every reply within the size budget', async () => {
    for (const t of DIAGRAM_TYPES) {
      const g = await guide({ type: t.slug });
      expect(g.length, t.slug).toBeLessThanOrEqual(MAX_GUIDE_CHARS);
    }
  });
});
