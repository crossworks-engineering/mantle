/**
 * Status narrator (Step 2). Rephrases a grounded status line ("Searching your
 * brain for “cars”…") into the assistant's warm first-person voice ("Let me dig
 * through your notes on cars…") for the live thought trail.
 *
 * It is a CHEAP, configurable AI worker — it reuses the owner's `summarizer`
 * worker (a fast remote model, e.g. gemini-flash-lite) rather than hardcoding a
 * model, honouring the "manifest is the single source of truth" rule. If
 * narration grows its own knobs, promote it to a dedicated `narrator` worker
 * kind; the call site here won't change.
 *
 * Always off the critical path: the caller fires this WITHOUT awaiting, and a
 * failure/empty result just leaves the grounded line in place (graceful). Gated
 * by `MANTLE_TURN_NARRATION` so the per-step LLM spend is opt-in.
 */

import { getDefaultWorker } from '@mantle/db';
import { resolveChatKey, resolveChatRoutes, chatWithFailover } from '@mantle/agent-runtime';

const NARRATION_PROMPT = `You narrate, in the FIRST PERSON, the single action an AI assistant is taking right now, so the user sees what it's doing. You are given a terse system status line. Rewrite it as ONE short, warm, natural first-person line — at most 8 words, present tense, no surrounding quotes, end with an ellipsis (…). Keep any specific topic or name from the input. Reply with ONLY the rewritten line.

Examples:
"Searching your brain for “cars”…" -> Let me dig through your notes on cars…
"Searching the web for “Acme news”…" -> Checking the web for the latest on Acme…
"Delegating to Researcher…" -> Handing this over to my Researcher…
"Working on it…" -> On it…`;

export function isTurnNarrationEnabled(): boolean {
  return !!process.env.MANTLE_TURN_NARRATION?.trim();
}

/** Strip wrapping quotes, collapse whitespace, cap length. */
function tidy(raw: string): string {
  let s = raw.trim().replace(/\s+/g, ' ');
  s = s.replace(/^["“”'']+/, '').replace(/["“”'']+$/, '').trim();
  if (s.length > 80) s = `${s.slice(0, 79)}…`;
  return s;
}

/**
 * Narrate one grounded status line. Returns the narrated line, or null to keep
 * the grounded one (no worker, no key, error, or empty output). Never throws.
 */
export async function narrateStatus(ownerId: string, grounded: string): Promise<string | null> {
  try {
    const worker = await getDefaultWorker(ownerId, 'summarizer');
    if (!worker) return null;
    const keyCheck = await resolveChatKey(ownerId, worker);
    if (!keyCheck.ok) return null;

    const routes = resolveChatRoutes(worker);
    const { result } = await chatWithFailover(ownerId, routes, {
      messages: [
        { role: 'system', content: NARRATION_PROMPT },
        { role: 'user', content: grounded },
      ],
      temperature: 0.7,
      maxTokens: 32,
    });
    const text = tidy(result.text ?? '');
    return text || null;
  } catch (err) {
    console.warn('[narrator] failed (keeping grounded line):', err instanceof Error ? err.message : err);
    return null;
  }
}
