import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { allHelpTopics, helpTopicForPath } from '@mantle/web-ui/layout/help-topics';
import { MANIFEST_TOOL_GROUPS } from './system-manifest/manifest';
import { parseFrontmatter, splitSections } from './help';

/**
 * Drift guard for per-screen help, in the same spirit as manifest.test.ts: the
 * route map, the content files and the tool-group registry are three lists that
 * must agree, and nothing in the app fails loudly when they don't — a missing
 * file just means a "?" that 404s in front of a new user. So it fails here.
 */

const HELP_DIR = path.resolve(__dirname, '../../../docs/guide/06-help');

const files = fs
  .readdirSync(HELP_DIR)
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.replace(/\.md$/, ''));

describe('help topics', () => {
  it('every mapped topic has a content file', () => {
    const missing = allHelpTopics().filter((t) => !files.includes(t));
    expect(missing, `mapped in help-topics.ts but no docs/guide/06-help/<topic>.md`).toEqual([]);
  });

  it('every content file is reachable from a route', () => {
    const mapped = new Set(allHelpTopics());
    const orphans = files.filter((f) => !mapped.has(f));
    expect(orphans, 'help file with no route in help-topics.ts — unreachable').toEqual([]);
  });

  it.each(files)('%s has exactly three sections and valid frontmatter', (topic) => {
    const raw = fs.readFileSync(path.join(HELP_DIR, `${topic}.md`), 'utf8');
    const { data, body } = parseFrontmatter(raw);
    const sections = splitSections(body);

    // Three ## sections, in order: the screen, the assistant, the technical.
    expect(sections).toHaveLength(3);
    for (const s of sections) {
      expect(s.heading.length).toBeGreaterThan(0);
      expect(s.markdown.length).toBeGreaterThan(0);
    }
    // The third is always the technical one, by convention and by parser order.
    expect(sections[2]?.heading).toBe('Technical');
    expect(data.title, 'frontmatter needs a title').toBeTruthy();
  });

  it.each(files)('%s declares only real tool groups', (topic) => {
    const raw = fs.readFileSync(path.join(HELP_DIR, `${topic}.md`), 'utf8');
    const { data } = parseFrontmatter(raw);
    const known = new Set(MANIFEST_TOOL_GROUPS.map((g) => g.slug));
    const unknown = data.toolGroups.filter((s) => !known.has(s));
    expect(unknown, 'tool group not in MANIFEST_TOOL_GROUPS').toEqual([]);
  });
});

describe('helpTopicForPath', () => {
  it('matches a list route and its detail routes', () => {
    expect(helpTopicForPath('/tables')).toBe('tables');
    expect(helpTopicForPath('/tables/abc-123')).toBe('tables');
    expect(helpTopicForPath('/tables/')).toBe('tables');
  });

  it('returns null for an unmapped route rather than guessing', () => {
    // Deliberately fictional: every real nav route now has a topic, so this
    // guards the "no topic ⇒ no button" path, not any particular screen.
    expect(helpTopicForPath('/settings/not-a-screen')).toBeNull();
    expect(helpTopicForPath('/nowhere')).toBeNull();
  });

  it('matches the dashboard exactly and does not swallow every route', () => {
    // '/' is a prefix of everything, so its entry is special-cased in the scan.
    expect(helpTopicForPath('/')).toBe('dashboard');
    expect(helpTopicForPath('/nowhere')).toBeNull();
  });

  it('does not let a short route swallow a longer one', () => {
    // Guards the longest-prefix sort: /pages must not capture /pages-something,
    // and a future '/' entry must never match every route.
    expect(helpTopicForPath('/pages')).toBe('pages');
    expect(helpTopicForPath('/pagesomething')).toBeNull();
  });
});
