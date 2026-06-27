/**
 * /api/dev-tools/ai-assist — invoke the Toolsmith agent from the API
 * Console's Assist panel. The user describes an integration ("read the
 * Mapbox docs at <url> and give my assistant travel times"); Toolsmith
 * web_fetches the docs, authors templated HTTP tools, tests them against
 * the live API, and bundles/grants them — then reports what it deployed.
 *
 * Mirrors the /pages and /tables ai-assist pattern: a dedicated endpoint
 * (skipping the persona hop) because the user is already IN the console,
 * and the panel refreshes the registry view from the reply.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { invokeAgent } from '@mantle/agent-runtime';
import { resolveAssistAgentSlug } from '@/lib/assist-agent';

const Body = z.object({
  prompt: z.string().min(1).max(8000),
  // Prior turns from the panel, so the one-shot delegation keeps continuity
  // (e.g. Toolsmith asks "which agent?" and the user answers next turn).
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(4000) }))
    .max(20)
    .optional(),
});

/** Render the recent transcript into a compact block, newest turns kept. */
function renderTranscript(history: Array<{ role: 'user' | 'assistant'; text: string }>): string {
  const recent = history.slice(-12);
  if (recent.length === 0) return '';
  const lines = recent.map((m) => {
    const who = m.role === 'user' ? 'User' : 'You';
    const text = m.text.length > 1200 ? `${m.text.slice(0, 1200)}…` : m.text;
    return `${who}: ${text}`;
  });
  return `Conversation so far (most recent last):\n${lines.join('\n')}\n\n`;
}

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }

  const agentSlug = await resolveAssistAgentSlug(user.id, 'dev-tools');
  if (!agentSlug) {
    return NextResponse.json(
      {
        error:
          'No Toolsmith is set up yet. Run `pnpm -C apps/web seed:toolsmith` (or finish onboarding) to provision the default API-integration specialist, or pick another agent in the panel.',
      },
      { status: 409 },
    );
  }

  // Light delegation frame: the user is in the API Console, so registry
  // questions ("what tools do I have?") are in-scope alongside authoring.
  // Toolsmith starts with api_tool_list/api_key_refs itself — no need to
  // preload registry state into the prompt. The transcript (when present)
  // carries continuity that the one-shot invokeAgent otherwise wouldn't have.
  const delegationPrompt =
    `The user is in Mantle's API Console (the tool-registry surface). ` +
    `Help them author, test, fix, or manage agent-callable API tools.\n` +
    `\n` +
    renderTranscript(parsed.data.history ?? []) +
    `User request:\n${parsed.data.prompt}`;

  const result = await invokeAgent({
    ownerId: user.id,
    agentSlug,
    prompt: delegationPrompt,
    depth: 1,
    parentTraceId: null,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({ ok: true, reply: result.text });
}
