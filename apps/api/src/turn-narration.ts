/**
 * Status narrator (Step 2). Rephrases a grounded status line ("Searching your
 * brain for “cars”…") into the assistant's warm first-person voice ("Let me dig
 * through your notes on cars…") for the live thought trail.
 *
 * It is a CHEAP, configurable AI worker. It runs on the owner's dedicated
 * `narrator` worker (a fast remote model, e.g. gemini-flash-lite) whose
 * `system_prompt` is the VERBOSITY dial — the user tunes it in Settings → AI
 * workers to say a terse phrase, a full sentence, or a short paragraph. Brains
 * that don't have a narrator worker yet fall back to the `summarizer` worker with
 * the built-in concise prompt, so behaviour degrades gracefully with no
 * regression. Either way the model lives in the manifest, never hardcoded here.
 *
 * Always off the critical path: the caller fires this WITHOUT awaiting, and a
 * failure/empty result just leaves the grounded line in place (graceful). On by
 * default; set `MANTLE_TURN_NARRATION=0` to suppress the per-step narration LLM
 * spend (the grounded status lines still stream).
 */

import { getDefaultWorker, type NarratorParams } from '@mantle/db';
import { resolveChatKey, resolveChatRoutes, chatWithFailover } from '@mantle/agent-runtime';

const NARRATION_PROMPT = `You narrate, in the FIRST PERSON, the single action an AI assistant is taking right now, so the user sees what it's doing. You are given a terse system status line. Rewrite it as ONE short, warm, natural first-person line — at most 8 words, present tense, no surrounding quotes, end with an ellipsis (…). Keep any specific topic or name from the input. Reply with ONLY the rewritten line.

Examples:
"Searching your brain for “cars”…" -> Let me dig through your notes on cars…
"Searching the web for “Acme news”…" -> Checking the web for the latest on Acme…
"Delegating to Researcher…" -> Handing this over to my Researcher…
"Working on it…" -> On it…`;

export function isTurnNarrationEnabled(): boolean {
  // On unless explicitly disabled (0/false/off/no). Unset → on.
  const v = process.env.MANTLE_TURN_NARRATION?.trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

/** Strip wrapping quotes, collapse whitespace onto one line, cap length. The cap
 *  is generous (a short paragraph) so a user who dials the narrator up to a
 *  sentence/paragraph isn't truncated — `max_tokens` is the real length control;
 *  this is just a runaway guard. */
function tidy(raw: string): string {
  let s = raw.trim().replace(/\s+/g, ' ');
  s = s.replace(/^["“”'']+/, '').replace(/["“”'']+$/, '').trim();
  if (s.length > 400) s = `${s.slice(0, 399)}…`;
  return s;
}

/**
 * Narrate one grounded status line. Returns the narrated line, or null to keep
 * the grounded one (no worker, no key, error, or empty output). Never throws.
 */
export async function narrateStatus(ownerId: string, grounded: string): Promise<string | null> {
  try {
    // Prefer the dedicated `narrator` worker (its system prompt + max_tokens are
    // the verbosity dial); fall back to the `summarizer` worker on brains that
    // don't have one yet, preserving the original behaviour exactly.
    const worker =
      (await getDefaultWorker(ownerId, 'narrator')) ??
      (await getDefaultWorker(ownerId, 'summarizer'));
    if (!worker) return null;
    const keyCheck = await resolveChatKey(ownerId, worker);
    if (!keyCheck.ok) return null;

    // Honour the narrator worker's own prompt + length knobs. The summarizer
    // fallback keeps the built-in concise voice — its own prompt/params are for
    // digesting conversations, not narrating, so we deliberately ignore them.
    const isNarrator = worker.kind === 'narrator';
    const params = (isNarrator ? worker.params : null) as NarratorParams | null;
    const systemPrompt =
      isNarrator && worker.systemPrompt?.trim() ? worker.systemPrompt : NARRATION_PROMPT;
    const temperature = params?.temperature ?? 0.7;
    const maxTokens = params?.max_tokens ?? 32;

    const routes = resolveChatRoutes(worker);
    const { result } = await chatWithFailover(ownerId, routes, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: grounded },
      ],
      temperature,
      maxTokens,
    });
    const text = tidy(result.text ?? '');
    return text || null;
  } catch (err) {
    console.warn('[narrator] failed (keeping grounded line):', err instanceof Error ? err.message : err);
    return null;
  }
}
