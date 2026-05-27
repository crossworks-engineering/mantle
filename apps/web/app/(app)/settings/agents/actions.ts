'use server';

/**
 * Server actions for the /settings/agents UI.
 *
 * The agents form's CRUD goes through `/api/agents` (REST); this file
 * holds the test-affordance action — same shape as the workers form's
 * testChatAction in [../ai-workers/actions.ts](../ai-workers/actions.ts).
 *
 * Lives separately because:
 *   - The test path resolves a runtime adapter, which is heavier than
 *     a CRUD insert/update and benefits from being an explicit
 *     server-action (typed handle the client can await).
 *   - The CRUD layer at /api/agents stays a plain REST surface so
 *     external scripts can manage agents the same way the UI does.
 */

import { requireOwner } from '@/lib/auth';
import { getAgent } from '@/lib/agents';
import { getApiKeyById } from '@mantle/api-keys';
import { getChatAdapter } from '@mantle/voice';

/**
 * Send a one-shot prompt through the agent's configured adapter and
 * return the reply. Drives the "Test chat" button on the agents form
 * so operators can validate provider + model + api key wiring without
 * triggering a real Telegram turn (or waiting for the next responder
 * loop).
 *
 * Routes through the SAME adapter the runtime uses — a successful
 * test here means the production responder / web /assistant path will
 * also work for this agent's configuration.
 *
 * Deliberately minimal:
 *   - No tool calls (tools=undefined). The point is to validate the
 *     credentials + provider + model triple, not the full tool loop.
 *   - No persona_notes / facts / digests folded in. The system prompt
 *     is sent verbatim.
 *   - max_tokens defaults to 500 so a runaway model doesn't burn
 *     budget — covers the typical greeting-length reply.
 */
export async function testAgentChatAction(
  agentId: string,
  prompt: string,
): Promise<{
  ok: true;
  reply: string;
  model: string;
  adapter: string;
  tokensIn: number | null;
  tokensOut: number | null;
}> {
  const user = await requireOwner();
  const agent = await getAgent(user.id, agentId);
  if (!agent) throw new Error('agent not found');
  if (!agent.apiKeyId) throw new Error('agent has no api_key configured');
  const apiKey = await getApiKeyById(agent.apiKeyId);
  if (!apiKey) throw new Error('api key not found or could not decrypt');

  const adapter = getChatAdapter(agent.provider);
  if (!adapter) {
    throw new Error(
      `No chat adapter registered for provider '${agent.provider}'. ` +
        `Register one in packages/voice/src/adapters/index.ts, or pick a ` +
        `wired provider in the dropdown.`,
    );
  }

  const trimmed =
    (prompt ?? '').trim() ||
    'Hello — please reply with a short greeting so I know you are wired correctly.';
  const params = agent.params as { temperature?: number; max_tokens?: number };

  const result = await adapter.chat({
    apiKey,
    model: agent.model,
    messages: [
      ...(agent.systemPrompt
        ? [{ role: 'system' as const, content: agent.systemPrompt }]
        : []),
      { role: 'user', content: trimmed },
    ],
    temperature: params.temperature,
    maxTokens: params.max_tokens ?? 500,
    // System prompt is stable per agent — mark it cacheable so the
    // test path exercises the same cache-write the production
    // responder relies on (Anthropic-direct prompts get the cache
    // read on subsequent test clicks within the 5min TTL).
    cacheControl: { systemPrompt: true },
  });

  return {
    ok: true,
    reply: result.text,
    model: result.model,
    adapter: adapter.adapterName,
    tokensIn: result.tokensIn ?? null,
    tokensOut: result.tokensOut ?? null,
  };
}
