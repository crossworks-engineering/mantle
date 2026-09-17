/**
 * The delegate roster — the live "what each delegate currently carries"
 * section appended to `invoke_agent`'s DESCRIPTION by the dynamic-schema
 * hook. Derived at toolset-assembly time from the delegates' granted tool
 * GROUPS (never stored, so a grant change reaches the parent on its next
 * turn), it lets the routing skill stay pure policy while capability facts
 * come from here.
 *
 * Security invariant: only BRAIN-AUTHORED text may enter the roster — group
 * names + group descriptions. Never tool slugs, tool descriptions, or remote
 * `serverInfo` strings: MCP connector tools carry third-party prose, and
 * pasting that into the persona's system prompt would re-open the injection
 * door the connectors audit closed (docs/mcp-connectors.md). Group name +
 * description are written by the brain (manifest or Toolsmith), so they are
 * the safe carrier — and they already hold the "when to use" prose.
 *
 * Split pure/impure: `renderDelegateRoster` is a pure function over plain
 * rows (unit-tested), `buildDelegateRoster` is the thin db loader the hook
 * calls.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { agents, db, toolGroups } from '@mantle/db';

/** Groups every conversational agent carries — pure noise in a capability
 *  line, so the renderer drops them. */
export const ROSTER_GROUP_STOPLIST: ReadonlySet<string> = new Set([
  'memory-core',
  'tool-results',
  'delegation',
  'persona',
]);

/** Max chars for one group's `Name (first sentence)` chunk. */
export const ROSTER_GROUP_CLIP = 90;
/** Max chars for one delegate's line before the `+N more` marker. */
export const ROSTER_LINE_MAX = 220;
/** Max chars for the whole roster before delegates are elided. */
export const ROSTER_TOTAL_MAX = 1200;

export type RosterGroup = { slug: string; name: string; description: string };
export type RosterDelegate = { slug: string; name: string; groups: RosterGroup[] };

/** First sentence of a description, whitespace collapsed to single spaces
 *  (descriptions may span lines; the roster is one line per delegate). */
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const match = flat.match(/^.*?[.!?](?=\s|$)/);
  return (match ? match[0] : flat).trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** `Name (first sentence of description)`, clipped to ROSTER_GROUP_CLIP. */
function groupChunk(group: RosterGroup): string {
  const sentence = firstSentence(group.description);
  return clip(sentence ? `${group.name} (${sentence})` : group.name, ROSTER_GROUP_CLIP);
}

/**
 * Render the roster block: one line per delegate in input order,
 * `slug — Group (sentence); Group (sentence)`, with the stoplist applied,
 * per-line and total caps enforced, and elisions self-announced (`+N more`).
 * Returns '' when there is nothing worth saying.
 */
export function renderDelegateRoster(delegates: readonly RosterDelegate[]): string {
  const lines: string[] = [];
  let total = 0;
  let elidedDelegates = 0;

  for (const delegate of delegates) {
    const chunks = delegate.groups
      .filter((g) => !ROSTER_GROUP_STOPLIST.has(g.slug))
      .map(groupChunk);

    const label =
      delegate.name && delegate.name.toLowerCase() !== delegate.slug.toLowerCase()
        ? `${delegate.slug} (${delegate.name})`
        : delegate.slug;

    let line = `- ${label} — `;
    if (chunks.length === 0) {
      line += '(no additional tool groups)';
    } else {
      let used = 0;
      for (const chunk of chunks) {
        const candidate = used === 0 ? line + chunk : `${line}; ${chunk}`;
        if (used > 0 && candidate.length > ROSTER_LINE_MAX) break;
        line = candidate;
        used += 1;
      }
      if (used < chunks.length) line += `; +${chunks.length - used} more`;
    }

    if (lines.length > 0 && total + 1 + line.length > ROSTER_TOTAL_MAX) {
      elidedDelegates += 1;
      continue;
    }
    total += (lines.length > 0 ? 1 : 0) + line.length;
    lines.push(line);
  }

  if (elidedDelegates > 0) lines.push(`- +${elidedDelegates} more delegates`);
  return lines.join('\n');
}

/**
 * Load the caller's delegates (enabled only) and their enabled tool groups,
 * then render. Missing/disabled delegates are skipped silently — the
 * `agent_slug` enum already constrains what the model may pass.
 */
export async function buildDelegateRoster(
  ownerId: string,
  delegateTo: readonly string[],
): Promise<string> {
  if (!delegateTo || delegateTo.length === 0) return '';

  const agentRows = await db
    .select({ slug: agents.slug, name: agents.name, toolGroupSlugs: agents.toolGroupSlugs })
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, ownerId),
        inArray(agents.slug, [...delegateTo]),
        eq(agents.enabled, true),
      ),
    );
  if (agentRows.length === 0) return '';

  const wanted = new Set<string>();
  for (const row of agentRows) {
    for (const slug of row.toolGroupSlugs) {
      if (!ROSTER_GROUP_STOPLIST.has(slug)) wanted.add(slug);
    }
  }

  const groupRows = wanted.size
    ? await db
        .select({
          slug: toolGroups.slug,
          name: toolGroups.name,
          description: toolGroups.description,
        })
        .from(toolGroups)
        .where(
          and(
            eq(toolGroups.ownerId, ownerId),
            inArray(toolGroups.slug, [...wanted]),
            eq(toolGroups.enabled, true),
          ),
        )
    : [];
  const groupsBySlug = new Map(groupRows.map((g) => [g.slug, g]));

  const order = new Map(delegateTo.map((slug, i) => [slug, i]));
  const delegates: RosterDelegate[] = agentRows
    .slice()
    .sort((a, b) => (order.get(a.slug) ?? 0) - (order.get(b.slug) ?? 0))
    .map((row) => ({
      slug: row.slug,
      name: row.name,
      groups: row.toolGroupSlugs
        .map((slug) => groupsBySlug.get(slug))
        .filter((g): g is RosterGroup => Boolean(g)),
    }));

  return renderDelegateRoster(delegates);
}
