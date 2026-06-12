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
import { requireOwner } from '@/lib/auth';
import { invokeAgent } from '@mantle/agent-runtime';
import { resolveAssistAgentSlug } from '@/lib/assist-agent';

const Body = z.object({
  prompt: z.string().min(1).max(8000),
});

export async function POST(req: Request) {
  const user = await requireOwner();
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
  // preload registry state into the prompt.
  const delegationPrompt =
    `The user is in Mantle's API Console (the tool-registry surface). ` +
    `Help them author, test, fix, or manage agent-callable API tools.\n` +
    `\n` +
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
