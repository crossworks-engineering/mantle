/**
 * Pure-renderer tests for the delegate roster (delegate-roster.ts): the
 * stoplist, the first-sentence extraction, newline stripping, and every cap
 * (group chunk, per-delegate line with `+N more`, whole-roster total). The
 * loader + hook wiring is covered in dynamic-schema.test.ts.
 */

import { describe, expect, it } from 'vitest';

// The module imports @mantle/db at top level for the loader; stub it so the
// pure renderer is testable without a database (same move as dispatch.test.ts).
import { vi } from 'vitest';
vi.mock('@mantle/db', () => ({ db: {}, agents: {}, toolGroups: {} }));

import {
  renderDelegateRoster,
  ROSTER_GROUP_CLIP,
  ROSTER_GROUP_STOPLIST,
  ROSTER_LINE_MAX,
  ROSTER_TOTAL_MAX,
  type RosterDelegate,
  type RosterGroup,
} from './delegate-roster';

const group = (slug: string, name: string, description = ''): RosterGroup => ({
  slug,
  name,
  description,
});

describe('renderDelegateRoster', () => {
  it('renders one line per delegate with group name + first sentence', () => {
    const out = renderDelegateRoster([
      {
        slug: 'researcher',
        name: 'Researcher',
        groups: [
          group('web-research', 'Web research', 'Search the live web. Results come back cited.'),
        ],
      },
    ]);
    expect(out).toBe('- researcher — Web research (Search the live web.)');
  });

  it('shows the display name when it differs from the slug', () => {
    const out = renderDelegateRoster([
      { slug: 'diagrammer', name: 'Draftsman', groups: [group('draws', 'Draws', 'Draw SVG.')] },
    ]);
    expect(out).toContain('- diagrammer (Draftsman) — ');
  });

  it('applies the stoplist and marks a delegate left with nothing', () => {
    const stoplisted = [...ROSTER_GROUP_STOPLIST].map((slug) =>
      group(slug, slug, 'Ubiquitous plumbing.'),
    );
    const out = renderDelegateRoster([{ slug: 'pages', name: 'Pages', groups: stoplisted }]);
    expect(out).toBe('- pages — (no additional tool groups)');
    for (const slug of ROSTER_GROUP_STOPLIST) expect(out).not.toContain(`${slug} (`);
  });

  it('strips newlines from descriptions — one line per delegate, always', () => {
    const out = renderDelegateRoster([
      {
        slug: 'coder',
        name: 'Coder',
        groups: [group('terminal', 'Terminal', 'Run shell\ncommands\non the box.')],
      },
    ]);
    expect(out).toBe('- coder — Terminal (Run shell commands on the box.)');
  });

  it('keeps a connector-group name + untrusted note within the clip', () => {
    const out = renderDelegateRoster([
      {
        slug: 'researcher',
        name: 'Researcher',
        groups: [
          group(
            'mcp-firecrawl',
            'Firecrawl (MCP)',
            'Scrape web pages via Firecrawl; results come back untrusted. Second sentence never shows.',
          ),
        ],
      },
    ]);
    expect(out).toContain('Firecrawl (MCP)');
    expect(out).toContain('untrusted');
    expect(out).not.toContain('Second sentence');
  });

  it('clips a single overlong group chunk to ROSTER_GROUP_CLIP', () => {
    const out = renderDelegateRoster([
      {
        slug: 'x',
        name: 'x',
        groups: [group('g', 'Group', `${'word '.repeat(60)}end.`)],
      },
    ]);
    const chunk = out.replace('- x — ', '');
    expect(chunk.length).toBeLessThanOrEqual(ROSTER_GROUP_CLIP);
    expect(chunk.endsWith('…')).toBe(true);
  });

  it('caps a delegate line and self-announces the elision with +N more', () => {
    const groups = Array.from({ length: 8 }, (_, i) =>
      group(`g${i}`, `Group number ${i}`, 'A reasonably long description sentence for sizing.'),
    );
    const out = renderDelegateRoster([{ slug: 'busy', name: 'busy', groups }]);
    expect(out).toMatch(/; \+\d+ more$/);
    const beforeMarker = out.replace(/; \+\d+ more$/, '');
    expect(beforeMarker.length).toBeLessThanOrEqual(ROSTER_LINE_MAX);
  });

  it('over budget, keeps every delegate and shrinks the lowest-ranked lines first', () => {
    const delegates: RosterDelegate[] = Array.from({ length: 20 }, (_, i) => ({
      slug: `agent-${i}`,
      name: `agent-${i}`,
      groups: [
        group('a', 'Alpha tools', 'Does the first thing rather thoroughly every time.'),
        group('b', 'Beta tools', 'Does the second thing rather thoroughly every time.'),
      ],
    }));
    const out = renderDelegateRoster(delegates);
    expect(out.length).toBeLessThanOrEqual(ROSTER_TOTAL_MAX);
    expect(out).not.toMatch(/more delegates/);
    const lines = out.split('\n');
    expect(lines).toHaveLength(20);
    // Rank order kept, and detail only ever decreases down the list.
    lines.forEach((line, i) => expect(line.startsWith(`- agent-${i}`)).toBe(true));
    const detail = (line: string) =>
      line.includes('Beta tools') ? 2 : line.includes('Alpha tools') ? 1 : 0;
    for (let i = 1; i < lines.length; i++) {
      expect(detail(lines[i]!)).toBeLessThanOrEqual(detail(lines[i - 1]!));
    }
    // The top delegate still carries a capability; the last is a bare name.
    expect(detail(lines[0]!)).toBeGreaterThan(0);
    expect(lines[19]).toBe('- agent-19');
  });

  it('shrinks only as much as needed: a small overflow trims just the tail', () => {
    const long = 'Does a very specific thing with a fairly long and descriptive sentence here.';
    const delegates: RosterDelegate[] = Array.from({ length: 7 }, (_, i) => ({
      slug: `d${i}`,
      name: `d${i}`,
      groups: [group('a', 'Alpha tools', long), group('b', 'Beta tools', long)],
    }));
    const out = renderDelegateRoster(delegates);
    const lines = out.split('\n');
    expect(lines).toHaveLength(7);
    expect(out.length).toBeLessThanOrEqual(ROSTER_TOTAL_MAX);
    expect(lines[0]).toContain('Beta tools'); // the top keeps its full line
    expect(lines[6]).not.toContain('Beta tools'); // the tail gave detail up
  });

  it('elides the tail only when even bare names overflow, and says so', () => {
    const delegates: RosterDelegate[] = Array.from({ length: 200 }, (_, i) => ({
      slug: `specialist-number-${i}`,
      name: `specialist-number-${i}`,
      groups: [group('a', 'Alpha tools', 'Does the first thing.')],
    }));
    const out = renderDelegateRoster(delegates);
    expect(out).toMatch(/\n- \+\d+ more delegates$/);
    const body = out.replace(/\n- \+\d+ more delegates$/, '');
    expect(body.length).toBeLessThanOrEqual(ROSTER_TOTAL_MAX);
    expect(body.split('\n').every((l) => /^- specialist-number-\d+$/.test(l))).toBe(true);
  });

  it('returns an empty string for no delegates', () => {
    expect(renderDelegateRoster([])).toBe('');
  });

  it('a group with an empty description renders as its bare name', () => {
    const out = renderDelegateRoster([{ slug: 'x', name: 'x', groups: [group('g', 'Calendar')] }]);
    expect(out).toBe('- x — Calendar');
  });
});
