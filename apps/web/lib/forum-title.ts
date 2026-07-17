/**
 * Auto-titling for forum topics started from the /team landing composer: the
 * member just types a message, and the topic title is a short summary of it.
 *
 * Uses the brain's default SUMMARIZER worker (the same one behind the
 * summarize_text tool) with a hard timeout; any miss — no worker configured,
 * provider not chat-wired, error, timeout, empty output — falls back to a
 * heuristic clip of the message's first line (lib/forum-title-text.ts, pure +
 * unit-tested). Title generation must never block or fail topic creation.
 *
 * Fallbacks are console.warn'd: a summarizer that silently never titles
 * (misconfigured key, reasoning model burning the token budget) would
 * otherwise be invisible to the owner.
 */
import { getApiKeyById } from '@mantle/api-keys';
import { bumpWorkerUsage, getDefaultWorker } from '@mantle/db';
import { getChatAdapter } from '@mantle/voice';
import { heuristicTitle, sanitizeTitle } from './forum-title-text';

const SUMMARIZE_TIMEOUT_MS = 6_000;

/**
 * A short topic title summarizing `body` — summarizer worker first, heuristic
 * fallback. Never throws, never returns empty.
 */
export async function titleForTopic(ownerId: string, body: string): Promise<string> {
  try {
    const worker = await getDefaultWorker(ownerId, 'summarizer');
    if (!worker?.apiKeyId) return heuristicTitle(body);
    const apiKey = await getApiKeyById(worker.apiKeyId);
    if (!apiKey) {
      console.warn(`[forum-title] summarizer '${worker.slug}' api_key undecryptable — heuristic`);
      return heuristicTitle(body);
    }
    const adapter = getChatAdapter(worker.provider);
    if (!adapter) {
      console.warn(
        `[forum-title] summarizer provider '${worker.provider}' has no chat adapter — heuristic`,
      );
      return heuristicTitle(body);
    }

    // Owner's worker tuning is respected; the low temperature default keeps
    // titles stable, and the owner's max_tokens matters for reasoning-style
    // models that need thinking budget before the (short) answer.
    const params = (worker.params ?? {}) as { temperature?: number; max_tokens?: number };
    const result = await Promise.race([
      adapter.chat({
        apiKey,
        model: worker.model,
        messages: [
          {
            role: 'system',
            content:
              'You title forum topics. Reply with ONLY a short title (at most 8 words) that summarizes the message, in the same language as the message. No quotes, no trailing period, no preamble.',
          },
          { role: 'user', content: body.slice(0, 4_000) },
        ],
        temperature: params.temperature ?? 0.2,
        maxTokens: params.max_tokens ?? 60,
        // The race abandons (can't cancel) the call on timeout — no internal
        // retries, so the loser doesn't keep backing off in the background.
        maxRetries: 0,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SUMMARIZE_TIMEOUT_MS)),
    ]);
    if (!result) {
      console.warn(
        `[forum-title] summarizer '${worker.slug}' timed out after ${SUMMARIZE_TIMEOUT_MS}ms — heuristic`,
      );
      return heuristicTitle(body);
    }
    void bumpWorkerUsage(worker.id);
    const title = sanitizeTitle(result.text);
    if (!title) {
      console.warn(`[forum-title] summarizer '${worker.slug}' returned empty text — heuristic`);
      return heuristicTitle(body);
    }
    return title;
  } catch (err) {
    console.warn(
      `[forum-title] summarizer failed — heuristic: ${err instanceof Error ? err.message : String(err)}`,
    );
    return heuristicTitle(body);
  }
}
