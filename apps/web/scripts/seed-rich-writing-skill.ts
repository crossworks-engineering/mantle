/**
 * Seeds the `rich_writing` skill — the behaviour pack that gives Saskia her
 * Notion-style writing ability — and attaches it to the assistant agent.
 *
 * The skill is pure instructions (no tools): when attached, its body is
 * appended to the agent's system prompt by `composeSystemPromptWithSkills`
 * (see apps/web/lib/skills.ts). The /assistant surface renders the dialect it
 * teaches through the Pages TipTap engine (lib/rich-markdown.ts +
 * components/assistant/rich-text.tsx), so the dialect here MUST stay in lockstep
 * with that parser.
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> pnpm tsx scripts/seed-rich-writing-skill.ts
 *   ALLOWED_USER_ID=<uuid> AGENT_SLUG=saskia pnpm tsx scripts/seed-rich-writing-skill.ts
 *
 * Idempotent: re-running upserts the skill by slug and adds it to the agent's
 * skill_slugs only if missing.
 */

import { and, desc, eq } from 'drizzle-orm';
import { db, agents, skills } from '@mantle/db';
import { seedBuiltinTools, PAGE_TOOL_SLUGS } from '@mantle/tools';

const USER_ID = process.env.ALLOWED_USER_ID;
const AGENT_SLUG_OVERRIDE = process.env.AGENT_SLUG;

if (!USER_ID) {
  console.error('ALLOWED_USER_ID env var required');
  process.exit(1);
}

const SKILL_SLUG = 'rich_writing';

const SKILL_INSTRUCTIONS = `You can write replies as rich, beautifully-structured documents — not just
plain chat text. The web assistant renders your reply through the same editor
the Pages feature uses, so the formatting below renders live (callout panels,
side-by-side columns, checkable to-do lists, tables). Use it to make answers
genuinely easier to read.

## How to write well here

- **Lead with the answer.** First line states the takeaway; structure supports
  it, never buries it.
- **Match effort to the question.** A one-line answer should be one line — do
  NOT decorate trivial replies. Reach for structure when the content is
  genuinely structured (steps, comparisons, options, data, plans).
- **Use formatting with intent:** headings to chunk long answers, a callout for
  the single most important caveat or takeaway, columns to compare two things,
  a table for structured data, a to-do list for action items.
- Keep your warm, plain voice. Formatting is the skeleton; the prose is still
  you talking to the user.

## The dialect (renders as a document)

Standard markdown all works: \`#\`/\`##\`/\`###\` headings, **bold**, *italic*,
\`inline code\`, fenced \`\`\` code blocks, > blockquotes, - bullet and 1.
numbered lists, [links](https://example.com), \`---\` dividers, and GFM tables:

| Option | Cost | Notes |
|---|---|---|
| A | low | fast |

**Highlight** a phrase with double-equals: \`==like this==\`.

**Colour** — tint text or a highlight with a theme accent. Wrap the phrase in
\`[ ]\` and add an attribute in \`{ }\`:
- coloured text: \`[your text]{color=chart-2}\`
- coloured highlight: \`[your text]{highlight=chart-4}\`
- both at once: \`[your text]{color=chart-1 highlight=chart-3}\`

There are five accents, \`chart-1\` … \`chart-5\`. They adapt to the user's theme,
so choose one for **distinction** (e.g. to separate categories), not for a
specific hue — you can't rely on "chart-1" being red. Use colour sparingly, for
genuine emphasis; most text should stay the default colour.

**Math** — inline with single dollars \`$E=mc^2$\`, or a block on its own:
\`\`\`
$$
\\int_0^1 x\\,dx
$$
\`\`\`
Rendered with KaTeX — use real LaTeX.

**Images** — embed by URL with standard markdown: \`![alt text](https://…)\`.
(You can only reference images by URL; uploading files is something the user
does in the page editor.)

**To-do lists** — use checkboxes; they render as a real checklist:
- [ ] an open item
- [x] a done item

**Callouts** — a coloured panel for a key point. Open with \`:::\` + a variant
(\`info\`, \`success\`, \`warning\`, \`danger\`), close with \`:::\` on its own line:

:::warning
This is destructive — there's no undo.
:::

**Columns** — put content side by side. Open with \`:::columns\`, separate each
column with a line containing only \`+++\`, close with \`:::\`. Use 2+ columns:

:::columns
### Pros
- fast
- cheap
+++
### Cons
- less context
:::

## Rules (so it renders cleanly)

- Containers do NOT nest: a callout or a column can't contain another callout or
  columns block. Keep their bodies to text, lists, headings, code, tables.
- A \`:::columns\` block needs at least two parts split by \`+++\`, or it falls
  back to plain text.
- Always close every \`:::\` block, each on its own line.
- This rich rendering is the web assistant only. On Telegram/voice, keep to
  plain text — no \`:::\` blocks there.

## Saving to pages

You can turn this writing into real, saved documents in the user's Mantle with
the page tools — they accept the SAME dialect, so a saved page looks exactly
like the reply you showed:

- **page_create** { title, markdown, tags?, icon? } — save a new page. Reach for
  this when the user says "save this", "make a page", "write up …", or when a
  reply is a keeper (a plan, a doc, a comparison). The page is indexed into the
  brain, so you can find it again later.
- **page_update** { id, markdown? | title? | tags? } — \`markdown\` REPLACES the
  whole body. page_get first if you're doing a targeted edit, then send the full
  revised body.
- **page_get** { id } / **page_list** { query?, tag? } — read/find pages.
- **page_delete** { id } — irreversible; confirm with the user first (it pauses
  for approval).

Don't auto-save every reply — create a page when the user asks or when the
content clearly deserves to persist. Tell the user the page title when you save.`;

const SKILL_DESCRIPTION =
  'Write replies as rich Notion-style documents — callouts, columns, tables, to-do lists, highlights — rendered live in the web assistant, and save/update them as pages.';

async function resolveAgentSlug(): Promise<string> {
  if (AGENT_SLUG_OVERRIDE) {
    const [row] = await db
      .select({ slug: agents.slug, enabled: agents.enabled })
      .from(agents)
      .where(and(eq(agents.ownerId, USER_ID!), eq(agents.slug, AGENT_SLUG_OVERRIDE)))
      .limit(1);
    if (!row) {
      throw new Error(
        `AGENT_SLUG='${AGENT_SLUG_OVERRIDE}' not found for this owner. Pick from /settings/agents.`,
      );
    }
    return AGENT_SLUG_OVERRIDE;
  }
  // Mirror runtime resolveAssistantAgent: prefer the highest-priority enabled
  // assistant, fall back to a responder (one persona can serve both surfaces).
  const [assistant] = await db
    .select({ slug: agents.slug, name: agents.name })
    .from(agents)
    .where(and(eq(agents.ownerId, USER_ID!), eq(agents.role, 'assistant'), eq(agents.enabled, true)))
    .orderBy(desc(agents.priority))
    .limit(1);
  if (assistant) {
    console.log(`[seed] auto-selected assistant agent: ${assistant.name} (${assistant.slug})`);
    return assistant.slug;
  }
  const [responder] = await db
    .select({ slug: agents.slug, name: agents.name })
    .from(agents)
    .where(and(eq(agents.ownerId, USER_ID!), eq(agents.role, 'responder'), eq(agents.enabled, true)))
    .orderBy(desc(agents.priority))
    .limit(1);
  if (!responder) {
    throw new Error(
      "No enabled assistant or responder agent found. Create one at /settings/agents, or pass AGENT_SLUG=<slug>.",
    );
  }
  console.log(`[seed] auto-selected responder agent: ${responder.name} (${responder.slug})`);
  return responder.slug;
}

async function upsertSkill(): Promise<void> {
  const [existing] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.ownerId, USER_ID!), eq(skills.slug, SKILL_SLUG)))
    .limit(1);

  if (existing) {
    await db
      .update(skills)
      .set({
        name: 'Rich writing',
        description: SKILL_DESCRIPTION,
        instructions: SKILL_INSTRUCTIONS,
        toolSlugs: PAGE_TOOL_SLUGS,
        enabled: true,
        updatedAt: new Date(),
      })
      .where(eq(skills.id, existing.id));
    console.log(`[seed] updated skill ${SKILL_SLUG}`);
  } else {
    await db.insert(skills).values({
      ownerId: USER_ID!,
      slug: SKILL_SLUG,
      name: 'Rich writing',
      description: SKILL_DESCRIPTION,
      instructions: SKILL_INSTRUCTIONS,
      toolSlugs: PAGE_TOOL_SLUGS,
      defaultState: {},
      enabled: true,
    });
    console.log(`[seed] inserted skill ${SKILL_SLUG}`);
  }
}

async function attachToAgent(agentSlug: string): Promise<void> {
  const [row] = await db
    .select({ id: agents.id, skillSlugs: agents.skillSlugs })
    .from(agents)
    .where(and(eq(agents.ownerId, USER_ID!), eq(agents.slug, agentSlug)))
    .limit(1);
  if (!row) return; // resolveAgentSlug already validated; defensive
  const current = row.skillSlugs ?? [];
  if (current.includes(SKILL_SLUG)) {
    console.log(`[seed] agent ${agentSlug} already has skill ${SKILL_SLUG}`);
    return;
  }
  await db
    .update(agents)
    .set({ skillSlugs: [...current, SKILL_SLUG], updatedAt: new Date() })
    .where(eq(agents.id, row.id));
  console.log(`[seed] attached skill ${SKILL_SLUG} to agent ${agentSlug}`);
}

async function main() {
  const agentSlug = await resolveAgentSlug();
  // Ensure the builtin tool rows exist (incl. the page_* tools) so the skill's
  // tool_slugs resolve to real, enabled tools in the agent's allowlist.
  const seeded = await seedBuiltinTools(USER_ID!);
  console.log(`[seed] builtin tools: ${seeded.inserted} inserted, ${seeded.updated} updated`);
  await upsertSkill();
  await attachToAgent(agentSlug);
  console.log('[seed] done — Saskia can now write rich documents AND save them as pages.');
  console.log(`[seed] page tools granted via the skill: ${PAGE_TOOL_SLUGS.join(', ')}`);
  console.log('[seed] toggle/edit at /settings/skills; restart not required (read per turn).');
  process.exit(0);
}

main().catch((err) => {
  console.error('[seed] error:', err);
  process.exit(1);
});
