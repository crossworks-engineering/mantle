/**
 * `design_guide`: the design rules for building a mini app or a Present
 * canvas (a deck, dashboard, landing page), one section at a time. Only app
 * and presentation work calls it (owner, 2026-11-16): in-app it sits in the
 * `design-guide` group, which only Appsmith and Presenter hold; over MCP its
 * description says the same.
 *
 * The text is Impeccable (impeccable.style, Apache 2.0), pinned at skill
 * v4.9.1: `docs/design-guide/upstream/` holds its files unchanged, and
 * `docs/design-guide/mantle/` holds Mantle's own medium and the task
 * playbooks adapted from it (docs/design-guide/README.md). Every reply starts
 * with the Mantle medium (the rules that win: no network, theme tokens in an
 * app, look once and fix once, and the scope: never the Mantle UI itself),
 * then the topic. A task topic adds the craft floor, the checks and bans read
 * before any build.
 *
 * Served on demand, never in a prompt: the app_authoring and
 * canvas_authoring skills (and the app guide doc for an MCP client) say which
 * topic to read before a build. No other prompt, skill or tool names it
 * (builtins-design-guide.test.ts, app-authoring-libraries.test.ts). Files baked into the image (MANTLE_DOCS_ROOT), read from
 * disk like the canvas library guides: no collection, no index, no model
 * call, no database.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { docsRoot } from '@mantle/files';
import type { BuiltinToolDef, ToolHandlerResult } from './types';
import { str } from './coerce';

export const DESIGN_GUIDE_DIR = 'design-guide';

/** The Impeccable release the text is taken from (README.md says the same). */
export const DESIGN_GUIDE_SOURCE = Object.freeze({
  name: 'Impeccable',
  version: '4.9.1',
  commit: 'acb4cfe14470b1fdf51e855431af618d936b7db8',
  license: 'Apache-2.0',
});

const MEDIUM = 'mantle/medium.md';
const FLOOR = 'upstream/craft-floor.md';

export type DesignTopic = Readonly<{
  /** The name a caller passes. */
  name: string;
  kind: 'task' | 'mode' | 'floor' | 'refine';
  /** One line: when to read it. */
  useFor: string;
  /** Relative to docs/design-guide/, in reply order (after the medium). */
  files: readonly string[];
  aliases?: readonly string[];
}>;

const refine = (name: string, useFor: string, aliases?: readonly string[]): DesignTopic => ({
  name,
  kind: 'refine',
  useFor,
  files: [`upstream/${name}.md`],
  ...(aliases ? { aliases } : {}),
});

/** Every topic, in index order. */
export const DESIGN_TOPICS: readonly DesignTopic[] = [
  {
    name: 'mini-app',
    kind: 'task',
    useFor: 'before you build or restyle a mini app',
    files: ['mantle/mini-app.md', FLOOR],
    aliases: ['app', 'mini app', 'miniapp'],
  },
  {
    name: 'dashboard',
    kind: 'task',
    useFor: 'before a dashboard, as a mini app or a canvas',
    files: ['mantle/dashboard.md', FLOOR],
  },
  {
    name: 'deck',
    kind: 'task',
    useFor: 'before a Present slide deck',
    files: ['mantle/deck.md', FLOOR],
    aliases: ['slides', 'slide deck', 'presentation'],
  },
  {
    name: 'landing-page',
    kind: 'task',
    useFor: 'before a landing page, campaign page or poster',
    files: ['mantle/landing-page.md', FLOOR],
    aliases: ['landing', 'poster', 'marketing page', 'campaign'],
  },
  {
    name: 'new-work',
    kind: 'task',
    useFor: 'a new surface with no look yet: find and commit the direction',
    files: ['mantle/new-work.md'],
    aliases: ['new', 'direction', 'world'],
  },
  {
    name: 'critique',
    kind: 'task',
    useFor: 'review a design: scores, issues, fixes',
    files: ['mantle/critique.md'],
    aliases: ['review', 'design review'],
  },
  {
    name: 'audit',
    kind: 'task',
    useFor: 'once after a build: pictures, a checklist, one fix pass',
    files: ['mantle/audit.md'],
    aliases: ['check', 'after build'],
  },
  {
    name: 'technical-audit',
    kind: 'task',
    useFor: 'a full scored audit: accessibility, performance, responsive, theming',
    files: ['upstream/audit.md'],
  },
  {
    name: 'operate',
    kind: 'mode',
    useFor: 'mode: the visitor does a task (apps, dashboards, tools)',
    files: ['upstream/mode-operate.md', 'upstream/operate.md'],
  },
  {
    name: 'read',
    kind: 'mode',
    useFor: 'mode: the visitor understands something (reports, guides)',
    files: ['upstream/mode-read.md'],
  },
  {
    name: 'persuade',
    kind: 'mode',
    useFor: 'mode: the visitor decides and acts (pitches, landing pages)',
    files: ['upstream/mode-persuade.md'],
  },
  {
    name: 'experience',
    kind: 'mode',
    useFor: 'mode: the visitor is inside the work (showcases, galleries)',
    files: ['mantle/experience.md', 'upstream/mode-persuade.md'],
  },
  {
    name: 'craft-floor',
    kind: 'floor',
    useFor: 'the checks and bans every build meets (each task topic includes it)',
    files: [FLOOR],
    aliases: ['floor', 'bans'],
  },
  refine('shape', 'plan the UX before code'),
  refine('layout', 'spacing, rhythm, hierarchy', ['spacing']),
  refine('typeset', 'type hierarchy and faces', ['type', 'typography', 'fonts']),
  refine('colorize', 'add strategic colour', ['color', 'colour']),
  refine('clarify', 'labels, UX copy, error messages', ['copy']),
  refine('harden', 'errors, edge cases, long content, i18n', ['edge cases']),
  refine('onboard', 'first run, empty states', ['empty states']),
  refine('adapt', 'other screen sizes', ['responsive']),
  refine('animate', 'purposeful motion', ['motion']),
  refine('polish', 'the final pass before handing over'),
  refine('distill', 'strip to the essence', ['simplify']),
  refine('quieter', 'tone down a loud design'),
  refine('bolder', 'lift a safe, bland design'),
  refine('delight', 'personality and small memorable touches'),
  refine('overdrive', 'push past convention (Persuade, Experience)'),
  refine('optimize', 'UI performance'),
];

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** The topic a caller asked for, by name or alias. Pure; exported for tests. */
export function resolveDesignTopic(asked: string): DesignTopic | null {
  const q = norm(asked);
  if (!q) return null;
  return (
    DESIGN_TOPICS.find((t) => t.name === q || (t.aliases ?? []).some((a) => norm(a) === q)) ?? null
  );
}

/** Where the guide may be: the docs root first, then the repo's docs/ seen
 *  from a process's or a package's cwd. */
function candidateDirs(): string[] {
  const cwd = process.cwd();
  return [
    path.join(docsRoot(), DESIGN_GUIDE_DIR),
    path.resolve(cwd, 'docs', DESIGN_GUIDE_DIR),
    path.resolve(cwd, '..', 'docs', DESIGN_GUIDE_DIR),
    path.resolve(cwd, '..', '..', 'docs', DESIGN_GUIDE_DIR),
  ];
}

export async function readDesignGuideFile(rel: string): Promise<string | null> {
  for (const dir of candidateDirs()) {
    try {
      return await readFile(path.join(dir, rel), 'utf8');
    } catch {
      // try the next one
    }
  }
  return null;
}

/** About how many tokens a text costs (four characters a token). */
export const approxTokens = (text: string): number => Math.ceil(text.length / 4);

/** One topic's reply text: the medium, then its files. Null when a file is
 *  missing (named in `missing`). */
export async function composeDesignTopic(
  topic: DesignTopic,
): Promise<{ text: string } | { missing: string }> {
  const parts: string[] = [];
  for (const rel of [MEDIUM, ...topic.files]) {
    const md = await readDesignGuideFile(rel);
    if (md === null) return { missing: rel };
    parts.push(md.trimEnd());
  }
  return { text: parts.join('\n\n---\n\n') + '\n' };
}

const SOURCE_LINE = `Impeccable ${DESIGN_GUIDE_SOURCE.version} (Apache 2.0), adapted for Mantle: docs/design-guide`;

function notOnServer(rel: string): ToolHandlerResult {
  return {
    ok: false,
    error: `The design guide (${DESIGN_GUIDE_DIR}/${rel}) is not on this server. Check MANTLE_DOCS_ROOT; meanwhile follow the app or canvas skill alone.`,
  };
}

/** The index (no topic) or one topic. */
export async function designGuideHandler(
  input: Record<string, unknown>,
): Promise<ToolHandlerResult> {
  const asked = str(input.topic).trim();
  if (!asked) {
    const topics: Array<{ topic: string; kind: string; for: string; tokens: number }> = [];
    for (const t of DESIGN_TOPICS) {
      const got = await composeDesignTopic(t);
      if ('missing' in got) return notOnServer(got.missing);
      topics.push({ topic: t.name, kind: t.kind, for: t.useFor, tokens: approxTokens(got.text) });
    }
    return {
      ok: true,
      output: {
        source: SOURCE_LINE,
        how: "Read the task topic before you build (mini-app, dashboard, deck, landing-page); each starts with the Mantle rules and ends with the craft floor. Pick the mode from the surface: operate, read, persuade, experience. After the build, run 'audit' once.",
        scope:
          'Only for building a mini app or a Present canvas. Not for other work, and never the Mantle interface itself, which keeps its own UI rules.',
        topics,
      },
    };
  }
  const topic = resolveDesignTopic(asked);
  if (!topic) {
    return {
      ok: false,
      error: `No design topic '${asked}'. Topics: ${DESIGN_TOPICS.map((t) => t.name).join(', ')}. Omit topic for the index.`,
    };
  }
  const got = await composeDesignTopic(topic);
  if ('missing' in got) return notOnServer(got.missing);
  return { ok: true, output: { topic: topic.name, source: SOURCE_LINE, guide: got.text } };
}

const design_guide: BuiltinToolDef = {
  slug: 'design_guide',
  policy: { effect: 'read', spends: 'none', scope: 'any' },
  name: 'Read the design guide',
  description:
    "Read the design rules for building a mini app or a Present canvas (a deck, dashboard, landing page or poster): Impeccable, adapted for Mantle, one section at a time. **Only for that work**: not for chat, pages, notes, tables, or the Mantle interface itself. Before `app_create` or `present_create`, call it with the task: 'mini-app', 'dashboard', 'deck' or 'landing-page' (each about 3k tokens: the Mantle rules, the playbook, the checks and bans). Modes: 'operate', 'read', 'persuade', 'experience'. After the build, 'audit' once; 'critique' to review one. Omit `topic` for the index with sizes. Reads only; changes nothing.",
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: `One topic: ${DESIGN_TOPICS.map((t) => t.name).join(', ')}. Omit for the index.`,
      },
    },
  },
  handler: (input) => designGuideHandler(input),
};

export const DESIGN_GUIDE_TOOLS: BuiltinToolDef[] = [design_guide];
