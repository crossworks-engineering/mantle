import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { getAgent } from '@/lib/agents';
import { getApiKeyById } from '@mantle/api-keys';
import { getChatAdapter } from '@mantle/voice';

const Body = z.object({ prompt: z.string().default('') });

/**
 * One-shot prompt through the agent's configured chat adapter — drives the
 * "Test chat" button on the agents form so operators can validate the
 * provider + model + api-key triple without triggering a real Telegram turn.
 *
 * Routes through the SAME adapter the runtime uses, so a success here means the
 * production responder / web assistant path will also work for this agent.
 * Deliberately minimal: no tools, no persona/facts/digests folded in, the
 * system prompt is sent verbatim, and max_tokens defaults to 500.
 *
 * Was the `testAgentChatAction` server action; moved to a REST endpoint so the
 * agents screen carries no server-action dependency (Electron / DB-less ready),
 * mirroring `/api/ai-workers/[id]/test/chat`.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'invalid input' }, { status: 400 });

  try {
    const agent = await getAgent(user.id, id);
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
      (parsed.data.prompt ?? '').trim() ||
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
      // System prompt is stable per agent — mark it cacheable so the test path
      // exercises the same cache-write the production responder relies on.
      cacheControl: { systemPrompt: true },
    });

    return NextResponse.json({
      ok: true,
      reply: result.text,
      model: result.model,
      adapter: adapter.adapterName,
      tokensIn: result.tokensIn ?? null,
      tokensOut: result.tokensOut ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
