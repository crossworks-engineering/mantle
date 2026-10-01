/**
 * A per-call fingerprint of the cached prompt prefix, for the trace. The
 * prompt cache hits only when the prefix is byte-identical to an earlier
 * call's, and the prefix is: the tool definitions, then each system block
 * that carries a cache marker (Anthropic) or the stable-prefix tag (every
 * provider that caches implicitly: grok, OpenAI, Gemini). Short hashes of those parts, stored on each
 * model-call step, show WHICH part changed when a call that should have hit
 * the cache did not (spike 9, dev-brain page e9539aaf: reflector notes and
 * tool order were suspects, but nothing recorded it).
 */
import { createHash } from 'node:crypto';
import type { ChatToolDefinition } from '@mantle/voice';
import { STABLE_PREFIX, type ChatMessage } from '../messages';

const short = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 8);

export type CacheFingerprint = {
  /** Hash of the tool definitions as sent, or null when no tools went out. */
  tools: string | null;
  /** Hash per stable-prefix system block, in prompt order. */
  blocks: string[];
  /** The upstream that served the call (OpenRouter routing metadata), or
   *  null when unknown. Each upstream keeps its own cache, so a switch
   *  (Anthropic ↔ Amazon Bedrock ↔ Google) misses with identical hashes. */
  provider?: string | null;
};

export function cacheFingerprint(
  messages: readonly ChatMessage[],
  tools: readonly ChatToolDefinition[] | null,
): CacheFingerprint {
  const blocks: string[] = [];
  for (const m of messages) {
    if (m.role !== 'system') continue;
    if (typeof m.content === 'string') {
      if (m[STABLE_PREFIX]) blocks.push(short(m.content));
      continue;
    }
    if (!m.content.some((p) => p.cacheControl)) continue;
    blocks.push(short(m.content.map((p) => p.text).join('')));
  }
  return { tools: tools && tools.length > 0 ? short(JSON.stringify(tools)) : null, blocks };
}
