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
import { db, agents } from '@mantle/db';
import { applyManifest } from '../lib/system-manifest/seed';

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

// ── Attach helper ────────────────────────────────────────────────────────────

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
  // Seed the three shared behaviour skills (+ their builtin tools) from the
  // manifest — the single source of truth for their definitions.
  await applyManifest(ownerId, {
    onlySkills: ['tool_grounding', 'voice_reply', 'page_editing'],
    mode: 'overwrite',
  });

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
