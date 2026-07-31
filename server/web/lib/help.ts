import path from 'node:path';
import { docsRoot, readMarkdownFile } from '@mantle/files';
import { MANIFEST_TOOL_GROUPS } from './system-manifest/manifest';

/**
 * Per-screen help — the three-part panel behind the header's "?".
 *
 * Content is plain markdown on disk under `docs/guide/06-help/`, inside the
 * User Guide collection. That placement is the point: the same files are
 * browsable at /docs AND indexed into the brain as `documentation` nodes, so
 * the assistant can answer "how do Tables work?" from the very text the panel
 * shows. A TS registry would have given us neither.
 *
 * Each file is three fixed `##` sections — the screen, the Assistant, the
 * Technical detail — plus frontmatter naming the tool groups the screen leans
 * on. Tool-group NAMES are never written into the prose: they're resolved from
 * the manifest at request time (below), so the copy can't drift from the real
 * grant graph the way a hardcoded list would.
 */

const HELP_REL_ROOT = 'guide/06-help';

/** Sections in render order. The parser is strict about these three. */
export type HelpSection = { heading: string; markdown: string };

export type HelpToolGroup = {
  slug: string;
  name: string;
  /** Tools the manifest declares for the group — the "what it can reach" count. */
  toolCount: number;
  /** True when at least one agent actually grants it (drives the Assistant section). */
  granted: boolean;
};

export type HelpTopic = {
  topic: string;
  title: string;
  /** "What this screen is for" — always present. */
  about: HelpSection;
  /** How to ask the assistant. Omitted when no declared group is granted. */
  assistant: HelpSection | null;
  /** How it works underneath. Always present. */
  technical: HelpSection;
  toolGroups: HelpToolGroup[];
  /** Set when the topic declares groups but none are granted — the teaching hint. */
  assistantHint: string | null;
};

/** Topic slugs are file names; keep them boring so path joins stay safe. */
const TOPIC_RE = /^[a-z0-9][a-z0-9-]*$/;

type Frontmatter = { title?: string; toolGroups: string[] };

/**
 * Minimal frontmatter reader — `title:` and a `toolGroups: [a, b]` inline list
 * are the only keys help files use, so a real YAML dependency would be dead
 * weight. Returns the body with the block stripped.
 */
export function parseFrontmatter(raw: string): { data: Frontmatter; body: string } {
  const empty: Frontmatter = { toolGroups: [] };
  if (!raw.startsWith('---')) return { data: empty, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { data: empty, body: raw }; // unclosed ⇒ treat as body
  const block = raw.slice(raw.indexOf('\n') + 1, end);
  const body = raw.slice(raw.indexOf('\n', end + 1) + 1);
  const data: Frontmatter = { toolGroups: [] };
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, key, rawValue] = m;
    const value = (rawValue ?? '').trim();
    if (key === 'title') {
      data.title = value.replace(/^["']|["']$/g, '');
    } else if (key === 'toolGroups') {
      data.toolGroups = value
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
  }
  return { data, body };
}

/**
 * Split a help body into its three `##` sections. Order is fixed by the file,
 * not by heading text, so a topic may name its first section after the screen
 * ("## Tables") while the other two keep their canonical names.
 */
export function splitSections(body: string): HelpSection[] {
  const out: HelpSection[] = [];
  const lines = body.split('\n');
  let heading: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (heading !== null) out.push({ heading, markdown: buf.join('\n').trim() });
    buf = [];
  };
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      heading = m[1] ?? '';
    } else if (heading !== null) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/** Absolute path to a topic's markdown, or null for a malformed slug. */
function topicRelPath(topic: string): string | null {
  if (!TOPIC_RE.test(topic)) return null;
  return path.posix.join(HELP_REL_ROOT, `${topic}.md`);
}

/**
 * Resolve declared group slugs against the manifest + the owner's live grants.
 * `granted` is what gates the Assistant section: a group nobody has been given
 * is a capability the reader does not actually have, and telling them how to
 * ask for it would be a lie.
 */
function resolveGroups(declared: string[], grantedSlugs: ReadonlySet<string>): HelpToolGroup[] {
  return declared.map((slug) => {
    const manifest = MANIFEST_TOOL_GROUPS.find((g) => g.slug === slug);
    return {
      slug,
      name: manifest?.name ?? slug,
      toolCount: manifest?.toolSlugs?.length ?? 0,
      granted: grantedSlugs.has(slug),
    };
  });
}

/**
 * Load one topic. `grantedSlugs` is the set of tool groups at least one agent
 * holds — pass an empty set and the Assistant section drops out, which is
 * exactly what a brain with no assistant should show.
 */
export async function loadHelpTopic(
  topic: string,
  grantedSlugs: ReadonlySet<string>,
): Promise<HelpTopic | null> {
  const rel = topicRelPath(topic);
  if (!rel) return null;
  const raw = await readMarkdownFile(docsRoot(), rel);
  if (raw === null) return null;

  const { data, body } = parseFrontmatter(raw);
  const sections = splitSections(body);
  if (sections.length < 3) return null; // malformed ⇒ better no panel than a broken one

  const [about, assistant, technical] = sections as [HelpSection, HelpSection, HelpSection];
  const toolGroups = resolveGroups(data.toolGroups, grantedSlugs);
  const anyGranted = toolGroups.length === 0 || toolGroups.some((g) => g.granted);

  return {
    topic,
    title: data.title ?? about.heading,
    about,
    assistant: anyGranted ? assistant : null,
    technical,
    toolGroups,
    assistantHint: anyGranted
      ? null
      : `The assistant can work with this once the ${toolGroups
          .map((g) => g.name)
          .join(
            ' / ',
          )} tool ${toolGroups.length === 1 ? 'group is' : 'groups are'} granted to an agent.`,
  };
}
