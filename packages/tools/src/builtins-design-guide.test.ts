/**
 * design_guide: the Impeccable design rules, adapted for Mantle, served one
 * section at a time (docs/design-guide/README.md). Pinned here: every topic's
 * files are on disk, every reply starts with the Mantle medium and stays
 * small (the lean context rule), a task topic carries the craft floor, the
 * scope line is there, no file has an em dash (house style), and the pinned
 * version and commit agree with the folder's README and NOTICE.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DESIGN_GUIDE_SOURCE,
  DESIGN_GUIDE_TOOLS,
  DESIGN_TOPICS,
  approxTokens,
  composeDesignTopic,
  resolveDesignTopic,
} from './builtins-design-guide';
import { listBuiltins } from './registry';

const ROOT = path.resolve(__dirname, '../../..');
const DIR = path.join(ROOT, 'docs/design-guide');
const tool = DESIGN_GUIDE_TOOLS[0]!;
const ctx = { ownerId: 'owner-1' };

/** A reply above this is no longer "a few thousand tokens". */
const MAX_REPLY_TOKENS = 4500;

function mdFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? mdFiles(path.join(dir, e.name))
      : e.name.endsWith('.md')
        ? [path.join(dir, e.name)]
        : [],
  );
}

describe('the design guide files', () => {
  it('keep the license, the notice and the pinned source', () => {
    expect(readFileSync(path.join(DIR, 'LICENSE'), 'utf8')).toContain('Apache License');
    for (const f of ['README.md', 'NOTICE.md']) {
      const md = readFileSync(path.join(DIR, f), 'utf8');
      expect(md, f).toContain(DESIGN_GUIDE_SOURCE.commit);
      expect(md, f).toContain(`v${DESIGN_GUIDE_SOURCE.version}`);
    }
  });

  it('have no em dash anywhere', () => {
    for (const f of mdFiles(DIR)) expect(readFileSync(f, 'utf8'), f).not.toContain('—');
  });

  it('say on each adapted Mantle file where it came from and that it changed', () => {
    for (const f of mdFiles(path.join(DIR, 'mantle'))) {
      if (f.endsWith('medium.md')) continue;
      const head = readFileSync(f, 'utf8').split('\n').slice(0, 4).join('\n');
      expect(head, f).toMatch(/Adapted for Mantle from Impeccable v4\.9\.1 .*Changed:/s);
    }
  });

  it('use every upstream file in some topic', () => {
    const used = new Set(DESIGN_TOPICS.flatMap((t) => t.files));
    for (const f of readdirSync(path.join(DIR, 'upstream'))) {
      expect(used.has(`upstream/${f}`), f).toBe(true);
    }
  });
});

describe('the topics', () => {
  it('have unique names and aliases', () => {
    const names = DESIGN_TOPICS.flatMap((t) => [t.name, ...(t.aliases ?? [])]);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(DESIGN_TOPICS.map((t) => [t.name, t] as const))(
    '%s: the medium first, the files on disk, a few thousand tokens at most',
    async (_name, topic) => {
      const got = await composeDesignTopic(topic);
      expect('text' in got, JSON.stringify(got)).toBe(true);
      if (!('text' in got)) return;
      expect(got.text.startsWith('# Design guide: the Mantle medium')).toBe(true);
      expect(got.text).toContain('never restyle it from here');
      expect(approxTokens(got.text)).toBeLessThanOrEqual(MAX_REPLY_TOKENS);
      if (
        topic.kind === 'task' &&
        ['mini-app', 'dashboard', 'deck', 'landing-page'].includes(topic.name)
      ) {
        expect(got.text).toContain('# Craft floor');
      }
    },
  );

  it('resolve by alias and loose spelling', () => {
    expect(resolveDesignTopic('Mini App')?.name).toBe('mini-app');
    expect(resolveDesignTopic('slides')?.name).toBe('deck');
    expect(resolveDesignTopic('landing_page')?.name).toBe('landing-page');
    expect(resolveDesignTopic('colour')?.name).toBe('colorize');
    expect(resolveDesignTopic('nope')).toBeNull();
  });
});

describe('the design_guide tool', () => {
  it('is named by no other tool: only app and presentation work reaches it', () => {
    for (const def of listBuiltins()) {
      if (def.slug === 'design_guide') continue;
      expect(def.description ?? '', def.slug).not.toContain('design_guide');
    }
    expect(tool.description).toContain('Only for that work');
  });

  it('is a read with no spend, on every surface', () => {
    expect(tool.policy).toEqual({ effect: 'read', spends: 'none', scope: 'any' });
    expect(tool.mcpOnly).toBeFalsy();
  });

  it('lists every topic with its size when no topic is given', async () => {
    const res = await tool.handler({}, ctx);
    expect(res.ok).toBe(true);
    const out = (
      res as { output: { topics: Array<{ topic: string; tokens: number }>; scope: string } }
    ).output;
    expect(out.topics.map((t) => t.topic)).toEqual(DESIGN_TOPICS.map((t) => t.name));
    expect(out.topics.every((t) => t.tokens > 0 && t.tokens <= MAX_REPLY_TOKENS)).toBe(true);
    expect(out.scope).toContain('Mantle interface itself');
  });

  it('serves one topic', async () => {
    const res = await tool.handler({ topic: 'mini-app' }, ctx);
    expect(res.ok).toBe(true);
    const out = (res as { output: { topic: string; guide: string; source: string } }).output;
    expect(out.topic).toBe('mini-app');
    expect(out.guide).toContain('# Task: a mini app');
    expect(out.source).toContain('Apache 2.0');
  });

  it('names the topics when the topic is unknown', async () => {
    const res = await tool.handler({ topic: 'brochure' }, ctx);
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain('mini-app, dashboard, deck');
  });
});
