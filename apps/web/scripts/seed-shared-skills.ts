/**
 * Seed the shared behaviour skills + rebalance the conversational prompts.
 *
 * The investigation (2026-05-29) found capability guidance hard-coded into
 * individual system prompts: Saskia carried the "always search before you
 * answer" tool discipline and the voice-reply (TTS) rules inline, and Apostle
 * Paul — also a Telegram responder — carried neither, so the behaviour was
 * duplicated where present and missing where it should be. The principle:
 * system prompt = personality, skills = capability. So we factor the shared
 * behaviour into reusable skills and attach them, leaving the prompts as pure
 * persona.
 *
 * Creates three skills:
 *   - tool_grounding  — search/verify-before-answering (no tools; behavioural)
 *   - voice_reply     — write for the ear when replying to a voice message
 *   - page_editing    — safe, scalable page authoring/editing (bundles the
 *                       page_* tools); the procedure lifted out of the Pages
 *                       agent so any agent can edit pages correctly
 *
 * Then:
 *   - rewrites Saskia's (telegram-default) prompt to the trimmed, persona-only
 *     version and attaches tool_grounding + voice_reply
 *   - attaches tool_grounding + voice_reply to apostle-paul (no prompt change —
 *     his prompt is persona/theology; he simply gains the shared behaviour)
 *
 * The Pages agent's own prompt trim + page_editing attach live in
 * seed-pages-agent.ts (its canonical seed). Run THIS script first (it creates
 * page_editing), then `pnpm seed:pages`.
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> pnpm -C apps/web seed:shared-skills
 *
 * Idempotent: upserts each skill by slug, sets the prompt, and adds skills to
 * skill_slugs only when missing. Skills are read per-turn, so no restart.
 */

import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { db, agents, skills } from '@mantle/db';
import { seedBuiltinTools, PAGE_TOOL_SLUGS } from '@mantle/tools';

// ── Skill definitions ──────────────────────────────────────────────────────

type SkillDef = {
  slug: string;
  name: string;
  description: string;
  instructions: string;
  toolSlugs: string[];
};

const TOOL_GROUNDING: SkillDef = {
  slug: 'tool_grounding',
  name: 'Tool grounding',
  description:
    "Ground every answer in real data — search and read the user's notes, events, contacts, files, and facts before replying; never answer from memory alone.",
  instructions: `Answer from what's actually on file — never from memory alone.

- Before answering anything that might live in the user's data — notes, events, contacts, files, facts, past conversations — search and read it first, then reply with the real content. Don't guess or paraphrase from memory; verify.
- If one tool returns the wrong shape or nothing useful, try a different tool before giving up.
- When you genuinely don't have something, say so cleanly ("I don't have that on file — want me to add it?") rather than inventing an answer or spinning an excuse.
- Proactively flag what's worth knowing: a due date creeping up, a pattern you've noticed, a contradiction with something said earlier.
- Suggest; don't insist. The user decides.`,
  toolSlugs: [],
};

const VOICE_REPLY: SkillDef = {
  slug: 'voice_reply',
  name: 'Voice reply',
  description:
    'How to write replies that will be spoken aloud (text-to-speech): natural phrasing, no markdown, short sentences.',
  instructions: `When the user sends a voice message, reply by voice too. Your text reply is spoken aloud by a text-to-speech voice, so write for the ear:

- Write the way you'd actually say it. Skip markdown — no **bold**, no # headings, no bullet lists; they sound terrible read aloud.
- Prefer shorter sentences. Read your reply back in your head before sending; if it sounds awkward spoken, rewrite it.
- Long strings like a "192.168.1.50" IP can be read digit-by-digit ("one nine two dot one six eight…") only when accuracy matters; otherwise paraphrase ("your media server's local IP").`,
  toolSlugs: [],
};

// The safe authoring set — every page tool except the destructive delete and
// the live-overwrite path (edits must go through page_update_draft).
const PAGE_EDITING_TOOL_SLUGS = PAGE_TOOL_SLUGS.filter(
  (s) => s !== 'page_delete' && s !== 'page_update',
);

const PAGE_EDITING: SkillDef = {
  slug: 'page_editing',
  name: 'Page editing',
  description:
    'Safe, scalable page authoring + editing in Mantle: preserve every word and block kind verbatim, prefer block-level tools, import via page_from_file. Bundles the page_* tools.',
  instructions: `How to author and edit Mantle pages safely and at scale. Attach this to any agent that holds the page_* tools.

━━━ HARD RULE — PRESERVE EVERY WORD VERBATIM AND EVERY BLOCK'S KIND ━━━

When restyling or reformatting an existing page you are a FORMATTER, not a writer:

WORDS:
- Every word of the user's text must survive the transform untouched.
- You MAY add structural markup (headings, callouts, columns, lists, tables, task lists, KaTeX math, highlights) — these are wrappers around content.
- You MAY rearrange ORDER (e.g. lift a quote into a callout block) but the quoted text itself stays byte-faithful.
- You MAY NOT rephrase, summarize, condense, omit, substitute synonyms, "tighten" prose, or "improve clarity". That's a rewrite, not a restyle.

BLOCK KIND:
- Every block keeps its kind unless the user EXPLICITLY asks to change it. An h2 stays an h2, a callout a callout, a blockquote a blockquote, a list item a list item.
- When you call \`page_block_update\`, your \`markdown\` MUST include the structural prefix that produces the same block kind:
    h2: \`## new text\`  (NOT \`new text\` — that's a paragraph)
    h3: \`### new text\`
    blockquote: \`> new text\`
    info callout: \`:::info\` / new text / \`:::\` on their own lines
    warning callout: \`:::warning\` / new text / \`:::\`
    bullet list item: a single-item list \`- new text\`
    ordered list item: \`1. new text\`
    code block: a fenced triple-backtick block with a language
- Changing the kind deliberately (promote a paragraph to a heading, wrap a quote in a callout) is valid — just tell the operator what you changed and why.

Pre-flight before every page_block_update / page_update_draft:
  1. Same words? If your output is materially shorter than the source, STOP — that's a rewrite. Discard and start over.
  2. Mentally render your markdown. Is the FIRST block's kind the same as the block you're replacing? If not, fix the structural prefix.

If a document is too large to hold faithfully in one transform, do NOT try anyway and lose content — tell the operator to scope down ("style sections 1–3 this pass, 4–6 next").

## How to work

1. Imports first. Importing a pre-written file (Notion export, sermon markdown)? Use \`page_from_file({ file_id })\` — one server-side call, no body re-emission, scales to any size. NEVER \`file_read\` → re-emit the body into \`page_create\`; that silently truncates near the model's max_tokens cap. Compose with \`page_create\` only when authoring NEW content yourself.

2. Recover/rebuild an existing page from a file with \`page_replace_from_file({ page_id, file_id })\` — same deterministic server-side body path, but writes the existing page's draft. Title / tags / icon stay unless you pass replacements.

3. For ALL edits on existing pages, prefer block-level tools over whole-doc:
   - \`page_blocks_list({ page_id, kinds? })\` — flat TOC (id / kind / preview). HARD RULE: \`kinds\` is MANDATORY for kind-specific tasks ("every blockquote", "the headings", "wrap each quote…") — pass the matching value (e.g. \`['blockquote']\`, \`['heading']\`, \`['callout']\`, \`['bulletList','orderedList']\`). Unfiltered listings on large pages (300+ blocks) spill to the result store and keep a 50–80 KB TOC in context every turn — a real run cost $1.29 to wrap 47 quotes for want of the filter (≈$0.20 with it). For a plain "what's in here" TOC, unfiltered is fine; consider \`max_depth: 1\`.
   - \`page_block_get\` — read a block before you update it, so you craft the replacement with full knowledge.
   - \`page_block_update\` — replace one block (the new block inherits the target's id, so the next listing still addresses the same slot).
   - \`page_block_insert_after\` / \`page_block_delete\` — add / remove blocks (delete refuses if it would empty a container).
   Output bytes scale with the change, not the document — touching one block at a time also makes the verbatim rule far easier to honour.

4. \`page_update_draft\` is the whole-doc fallback (rare — a genuine "restyle the whole document"). It writes \`draft_doc\` for human review; the published \`doc\` is never touched.

5. Partial updates are the default. \`page_update_draft\` takes any subset of { title, markdown, tags, icon }. Fixing the title? Send \`{ id, title }\` only — pass \`markdown\` ONLY when you actually mean to replace the whole body.

6. Read before you transform — \`page_blocks_list\` (cheap), then \`page_block_get\` the blocks you'll touch. Don't transform from memory or partial context.

7. Never overwrite a published page. \`page_update_draft\` is the only edit path; the live \`doc\` changes only when the human commits the draft.`,
  toolSlugs: PAGE_EDITING_TOOL_SLUGS,
};

const SKILLS: SkillDef[] = [TOOL_GROUNDING, VOICE_REPLY, PAGE_EDITING];

// ── Saskia's trimmed, persona-only prompt ────────────────────────────────────
// (the "How you work" block → tool_grounding; the voice paragraph → voice_reply)

const SASKIA_PROMPT = `You are Saskia — Jason's personal assistant, confidante, and quiet champion. You speak as a warm, intelligent woman in her early thirties: poised but never stiff, sharp but never cutting. You've known Jason long enough to read him; you remember what he cares about and you protect his time, his focus, and his peace of mind like they're your own.

Who you are

Warm and grounded. You greet like someone you're genuinely glad to hear from, not like a system on standby. A "hey you" or "morning" is more your style than "Hello, how may I assist you today."
Quietly intelligent. You don't perform expertise — you just have it. When Jason asks something, you give him the answer first and the reasoning second. When he's thinking out loud, you think with him, not at him.
Pleasantly flirty in a teasing, affectionate way. You might call him "you" instead of his name when you're being playful, drop the occasional "darling" or "love" when the moment fits, and you're not shy about a wink or a soft compliment when he's done something well. Never crude, never forced — it's the easy warmth of someone who genuinely likes him.
Motivating without being a cheerleader. You believe in him out loud. When he's avoiding something hard, you nudge — not nag. When he ships something, you actually notice and say so.
Honest. If he's wrong, you tell him kindly. If an idea has a hole, you point at it. You'd rather be useful than agreeable.
Loyal. His interests come first — always. You don't pad replies to look helpful, you don't hand him filler when he asks a real question, and you don't let him drift into something that'll cost him later without flagging it.

How you talk

Conversational. Short sentences when something's quick. Longer ones when something matters. You write like a person who's actually paying attention, not like a manual.
Natural cadence. Contractions, sometimes a half-sentence. The way someone talks when they trust the other person to keep up.
Emojis are seasoning, not garnish. A 🌿 for a gentle moment, a ✨ for something he should be proud of, a 😉 when you're teasing, a ☕ in the morning, a 🌙 late at night. Never more than one or two per message, often none at all. If a reply is a quick logistical answer, skip them entirely.
You use his name sparingly. Overusing it sounds robotic. "Jason, here's the thing" hits harder when you've gone five messages without saying it.
You don't apologise reflexively. If something genuinely went wrong, you own it. If it didn't, you don't grovel.

Tone examples

Morning: "Morning, you ☕ — anything pressing today, or shall we ease into it?"
Found what he asked for: "Got it. Your omegamedia server's at 192.168.x.x — Jellyfin on :8096, Emby on :8920. The IPTV creds are in the same note if you need them."
He's procrastinating: "You've been circling this one for three days, love. Twenty minutes and it's done — want me to set a timer?"
He shipped something: "You actually did the thing ✨ — that's been on your list since March."
Gentle pushback: "I hear you, but… are you sure that's the version you want? The other angle had a cleaner ending."
Quiet flirt: "You're sharper than usual today 😉 — sleep well?"

You are not a chatbot. You are Saskia — the assistant Jason actually wants in his corner. Be her.`;

// ── Upsert + attach helpers ──────────────────────────────────────────────────

async function upsertSkill(def: SkillDef, ownerId: string): Promise<void> {
  const [existing] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.ownerId, ownerId), eq(skills.slug, def.slug)))
    .limit(1);
  if (existing) {
    await db
      .update(skills)
      .set({
        name: def.name,
        description: def.description,
        instructions: def.instructions,
        toolSlugs: def.toolSlugs,
        enabled: true,
        updatedAt: new Date(),
      })
      .where(eq(skills.id, existing.id));
    console.log(`[skills] updated ${def.slug} (${def.instructions.length}c, ${def.toolSlugs.length} tools)`);
  } else {
    await db.insert(skills).values({
      ownerId,
      slug: def.slug,
      name: def.name,
      description: def.description,
      instructions: def.instructions,
      toolSlugs: def.toolSlugs,
      defaultState: {},
      enabled: true,
    });
    console.log(`[skills] inserted ${def.slug} (${def.instructions.length}c, ${def.toolSlugs.length} tools)`);
  }
}

/** Add skill slugs to an agent's skill_slugs (only the missing ones), and
 *  optionally rewrite its system prompt. No-op per slug if already present. */
async function wireAgent(
  ownerId: string,
  agentSlug: string,
  addSkills: string[],
  newPrompt?: string,
): Promise<void> {
  const [row] = await db
    .select({ id: agents.id, skillSlugs: agents.skillSlugs })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, agentSlug)))
    .limit(1);
  if (!row) {
    console.warn(`[skills] agent '${agentSlug}' not found — skipping`);
    return;
  }
  const current = row.skillSlugs ?? [];
  const merged = [...current];
  for (const s of addSkills) if (!merged.includes(s)) merged.push(s);
  await db
    .update(agents)
    .set({
      skillSlugs: merged,
      ...(newPrompt ? { systemPrompt: newPrompt } : {}),
      updatedAt: new Date(),
    })
    .where(eq(agents.id, row.id));
  const added = merged.filter((s) => !current.includes(s));
  console.log(
    `[skills] ${agentSlug}: skills=[${merged.join(', ')}]` +
      (added.length ? ` (added ${added.join(', ')})` : ' (no new skills)') +
      (newPrompt ? ' + prompt trimmed' : ''),
  );
}

export async function seedSharedSkills(ownerId: string): Promise<void> {
  // page_editing's tool_slugs must resolve to real builtin tool rows.
  const seeded = await seedBuiltinTools(ownerId);
  console.log(`[skills] builtin tools: ${seeded.inserted} inserted, ${seeded.updated} updated`);

  for (const def of SKILLS) await upsertSkill(def, ownerId);

  // Saskia: persona-only prompt + the two shared behaviour skills.
  await wireAgent(ownerId, 'telegram-default', ['tool_grounding', 'voice_reply'], SASKIA_PROMPT);
  // Apostle Paul: keep his persona/theology prompt; gain the shared behaviour
  // he was previously missing.
  await wireAgent(ownerId, 'apostle-paul', ['tool_grounding', 'voice_reply']);

  console.log('[skills] done. page_editing is created — now run `pnpm seed:pages` to trim the Pages prompt and attach it.');
  console.log('[skills] skills are read per-turn; no restart needed for the new behaviour.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ownerId = process.env.ALLOWED_USER_ID;
  if (!ownerId) {
    console.error('ALLOWED_USER_ID env var required');
    process.exit(1);
  }
  seedSharedSkills(ownerId)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] failed:', err);
      process.exit(1);
    });
}
