/**
 * `app_authoring_guide`: the mini-app authoring guide (docs/app-authoring-guide.md)
 * for an MCP client, on demand (task 603f6970, 2026-10-05).
 *
 * Inside the brain, Appsmith carries the `app_authoring` skill. An outside
 * Claude driving the app_* tools over MCP had nothing but the tool
 * descriptions, so it could not learn `host.me()`, the `:host_me_*` SQL
 * parameters or the level rules, and told a member "user session detail is
 * not available in the app". This serves the canonical guide (baked into the
 * image under MANTLE_DOCS_ROOT=/app/docs) as a read, whole or one section.
 *
 * `mcpOnly`: in-app agents have the skill, so it is never seeded or granted.
 * Read-only, no model call, no database: one file read.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { docsRoot } from '@mantle/files';
import type { BuiltinToolDef } from './types';
import { str } from './coerce';

export const APP_GUIDE_FILE = 'app-authoring-guide.md';

/** Where the guide may be: the docs root first (prod: /app/docs), then the
 *  repo's docs/ seen from a dev process's cwd (server/web, server/api). */
function candidatePaths(): string[] {
  const cwd = process.cwd();
  return [
    path.join(docsRoot(), APP_GUIDE_FILE),
    path.resolve(cwd, 'docs', APP_GUIDE_FILE),
    path.resolve(cwd, '..', 'docs', APP_GUIDE_FILE),
    path.resolve(cwd, '..', '..', 'docs', APP_GUIDE_FILE),
  ];
}

async function readGuide(): Promise<string | null> {
  for (const p of candidatePaths()) {
    try {
      return await readFile(p, 'utf8');
    } catch {
      // try the next one
    }
  }
  return null;
}

type GuideSection = { heading: string; text: string };

/** Split the guide at its `## ` headings (a `### ` stays inside its parent).
 *  Fenced code is skipped, so a `## ` inside an example never splits. Pure;
 *  exported for tests. */
export function splitGuideSections(md: string): GuideSection[] {
  const out: GuideSection[] = [];
  let current: GuideSection | null = null;
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = !inFence ? /^## (.+)$/.exec(line) : null;
    if (h) {
      if (current) out.push(current);
      current = { heading: h[1]!.trim(), text: line };
    } else if (current) {
      current.text += '\n' + line;
    }
  }
  if (current) out.push(current);
  return out.map((s) => ({ ...s, text: s.text.trimEnd() }));
}

/** The sections whose heading contains `query` (case and punctuation
 *  ignored). Pure; exported for tests. */
export function findGuideSections(sections: GuideSection[], query: string): GuideSection[] {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const q = norm(query);
  if (!q) return [];
  return sections.filter((s) => norm(s.heading).includes(q));
}

const app_authoring_guide: BuiltinToolDef = {
  slug: 'app_authoring_guide',
  readOnly: true,
  mcpOnly: true,
  name: 'Read the mini-app authoring guide',
  description:
    "Read the guide to building a Mantle mini app with the app_* tools. Call it BEFORE writing an app. It covers who runs the app (`host.me()` gives `{ id, name, kind }`; `:host_me_id`, `:host_me_name`, `:host_me_kind` in host.db SQL record who did something, filled by the server), the `@host` bridge (host.db, host.tools.call with app_tools_set), allowed imports, theme tokens, per-app SQLite, sharing, and the team and client level rules. Omit `section` for the whole guide (about 8k tokens); pass one, e.g. 'who is running', for that part only.",
  inputSchema: {
    type: 'object',
    properties: {
      section: {
        type: 'string',
        description:
          "Part of a section heading, e.g. 'who is running the app', 'host', 'binding to data', 'sqlite', 'sharing', 'team apps'. Omit for the whole guide.",
      },
    },
  },
  handler: async (input) => {
    const md = await readGuide();
    if (md === null) {
      return {
        ok: false,
        error: `The app authoring guide (${APP_GUIDE_FILE}) is not on this server. Check MANTLE_DOCS_ROOT.`,
      };
    }
    const section = str(input.section).trim();
    if (!section) return { ok: true, output: { guide: md } };
    const sections = splitGuideSections(md);
    const hits = findGuideSections(sections, section);
    if (hits.length === 0) {
      return {
        ok: false,
        error: `No section matches '${section}'. Sections: ${sections.map((s) => s.heading).join('; ')}.`,
      };
    }
    return {
      ok: true,
      output: { section: hits.map((s) => s.heading), text: hits.map((s) => s.text).join('\n\n') },
    };
  },
};

export const APP_GUIDE_TOOLS: BuiltinToolDef[] = [app_authoring_guide];
