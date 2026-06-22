/**
 * /api/apps/[id]/ai-assist — invoke the Appsmith agent on the given app with
 * the user's prompt. Appsmith authors source (app_file_write), builds
 * (app_build), and declares tools/sqlite; all edits land in the draft. After
 * the run we rebuild the draft and return Appsmith's status, the build result,
 * and which files changed — so the /apps Assist panel updates without a refresh.
 *
 * Mirrors /api/pages/[id]/ai-assist (skip the Saskia hop; preload app context).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { getApp, workingSource } from '@mantle/content';
import { invokeAgent } from '@mantle/agent-runtime';
import { resolveAssistAgentSlug } from '@/lib/assist-agent';
import { runAppBuild } from '@/lib/app-build-run';

export const runtime = 'nodejs';

const Body = z.object({
  prompt: z.string().min(1).max(8000),
  /** data-app-region ids the user marked in the preview, to focus the edit. */
  focusRegionIds: z.array(z.string()).max(200).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'invalid input' }, { status: 400 });

  const before = await getApp(user.id, id);
  if (!before) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  const beforeFiles = workingSource(before).files;

  const focus =
    parsed.data.focusRegionIds && parsed.data.focusRegionIds.length
      ? `\nFocus ONLY on the components rendering these regions (data-app-region): ${parsed.data.focusRegionIds.join(', ')}. Leave everything else unchanged.\n`
      : '';

  const delegationPrompt =
    `You are editing the mini app below. Read its current files with app_get ` +
    `(include_source: true), make the requested change with app_file_write, then ` +
    `app_build until it compiles. All edits land in the draft for the user to review.\n` +
    `\n` +
    `App id:   ${id}\n` +
    `App name: ${before.title}\n` +
    focus +
    `\n` +
    `User request:\n${parsed.data.prompt}`;

  const agentSlug = await resolveAssistAgentSlug(user.id, 'apps');
  if (!agentSlug) {
    return NextResponse.json(
      {
        error:
          'No Apps assistant is set up yet. Pick one in the Assist panel, or finish onboarding to provision the default Appsmith specialist.',
      },
      { status: 409 },
    );
  }

  const result = await invokeAgent({
    ownerId: user.id,
    agentSlug,
    prompt: delegationPrompt,
    depth: 1,
    parentTraceId: null,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });

  // Rebuild the draft so the preview reflects what Appsmith just wrote (it may
  // already have built, but a fresh build keeps the staged artifact current),
  // and diff the file map for the editor to flag.
  const build = await runAppBuild(user.id, id);
  const after = await getApp(user.id, id);
  if (!after) return NextResponse.json({ error: 'app disappeared mid-run' }, { status: 500 });
  const afterFiles = workingSource(after).files;

  const changedFiles: string[] = [];
  for (const path of new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)])) {
    if (beforeFiles[path] !== afterFiles[path]) changedFiles.push(path);
  }

  return NextResponse.json({
    ok: true,
    reply: result.text,
    build: build ? { ok: build.buildOk, errors: build.errors, warnings: build.warnings } : null,
    changedFiles,
    hasDraft: after.hasDraft,
  });
}
