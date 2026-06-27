import { NextResponse } from 'next/server';

import { getOwnerOr401 } from '@/lib/auth';
import { getAgent } from '@/lib/agents';
import { getApiKeyById } from '@mantle/api-keys';
import { getChatAdapter } from '@mantle/voice';
import { resolveAgentSkills, composeSystemPromptWithSkills } from '@mantle/agent-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Agent Studio Phase 4 — the no-persist sandbox (docs/agent-studio.md).
 *
 * Run a multi-turn conversation against an agent's CURRENT config without
 * writing anything: no recordTurn, no nodes, no conversation store, no tool loop,
 * no memory triggers. Purely an ephemeral `adapter.chat()` call — the same path
 * the one-shot test button uses (settings/agents testAgentChatAction), extended
 * to multi-turn and composing the FULL prompt (system_prompt + attached skills,
 * exactly as the Studio's composed-prompt preview shows).
 *
 * The conversation lives in the client; each request is stateless — the server
 * prepends the freshly-composed system prompt and calls the model. Tools and
 * memory are deliberately off, so it's safe to spam: nothing lands in the brain.
 */

const MAX_MESSAGES = 40;
const MAX_CONTENT = 8000;
const MAX_REPLY_TOKENS = 8192;

type Msg = { role: 'user' | 'assistant'; content: string };

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  let payload: { agentId?: string; messages?: Msg[] };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const agentId = payload.agentId ?? '';
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (!agentId) return NextResponse.json({ error: 'agentId required' }, { status: 400 });
  if (messages.length === 0) return NextResponse.json({ error: 'messages required' }, { status: 400 });
  if (messages.length > MAX_MESSAGES) {
    return NextResponse.json({ error: `too many turns (max ${MAX_MESSAGES}) — reset the sandbox` }, { status: 400 });
  }

  const clean: Msg[] = messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content ?? '').slice(0, MAX_CONTENT),
  }));

  try {
    const agent = await getAgent(user.id, agentId);
    if (!agent) return NextResponse.json({ error: 'agent not found' }, { status: 404 });
    if (!agent.apiKeyId) return NextResponse.json({ error: `${agent.name} has no API key — set one in Settings → Agents` }, { status: 400 });
    const apiKey = await getApiKeyById(agent.apiKeyId);
    if (!apiKey) return NextResponse.json({ error: 'API key not found or could not decrypt' }, { status: 400 });
    const adapter = getChatAdapter(agent.provider);
    if (!adapter) return NextResponse.json({ error: `no chat adapter for provider '${agent.provider}'` }, { status: 400 });

    // Compose the same prompt a real turn assembles: base + attached skills.
    const skills = await resolveAgentSkills(user.id, agent.skillSlugs ?? []);
    const systemPrompt = composeSystemPromptWithSkills(agent.systemPrompt, skills);
    const params = agent.params as { temperature?: number; max_tokens?: number };

    const result = await adapter.chat({
      apiKey,
      model: agent.model,
      messages: [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        ...clean,
      ],
      temperature: params.temperature,
      maxTokens: Math.min(params.max_tokens ?? 1024, MAX_REPLY_TOKENS),
      cacheControl: { systemPrompt: true },
    });

    return NextResponse.json({
      reply: result.text,
      model: result.model,
      tokensIn: result.tokensIn ?? null,
      tokensOut: result.tokensOut ?? null,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
