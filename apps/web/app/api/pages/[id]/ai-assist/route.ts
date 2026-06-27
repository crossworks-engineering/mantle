/**
 * /api/pages/[id]/ai-assist — invoke the Pages agent on the given page
 * with the user's prompt. Pages does its work (page_blocks_list →
 * page_block_get → page_block_update / page_update_draft), all writes
 * land in `draft_doc`, and the response carries Pages's status text plus
 * a block-level diff summary the panel renders next to the chat.
 *
 * Why a dedicated endpoint vs delegating from /assistant: this is the
 * editor side panel — the user is already IN the page. We can skip the
 * Saskia hop, preload the page context into the prompt, and return diff
 * info directly so the panel updates without a refresh round-trip.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { getPage } from '@/lib/pages';
import { buildFocusDirective } from '@/lib/focus-directive';
import { diffBlocks } from '@mantle/content';
import { invokeAgent } from '@mantle/agent-runtime';
import { resolveAssistAgentSlug } from '@/lib/assist-agent';

const Body = z.object({
  prompt: z.string().min(1).max(8000),
  /** Block ids the user marked via the gutter focus marker. When present,
   *  Pages is instructed to operate ONLY on these blocks. */
  focusBlockIds: z.array(z.string()).max(200).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }

  // Confirm the page exists + the caller owns it before spawning an agent.
  // (The agent would also fail to find it, but we want a clean 404 here.)
  const before = await getPage(user.id, id);
  if (!before) return NextResponse.json({ error: 'page not found' }, { status: 404 });

  // A focus set narrows Pages to exactly the blocks the user marked in the
  // gutter. Pages already edits by block id, so this is a prompt directive —
  // no new tools (see buildFocusDirective for the safety contract).
  const focusDirective = buildFocusDirective(parsed.data.focusBlockIds);

  // Compose the delegation prompt. Embed the page's id + title so Pages
  // doesn't have to guess + can start with page_blocks_list immediately.
  // The user's prompt is the actual intent ("add callouts on the quotes").
  const delegationPrompt =
    `You are editing the page below. Read its block structure first via ` +
    `page_blocks_list, then make the requested change with block-level tools ` +
    `(page_block_update / insert_after / delete). All edits land in the ` +
    `draft — the user will review and commit.\n` +
    `\n` +
    `Page id:    ${id}\n` +
    `Page title: ${before.title}\n` +
    focusDirective +
    `\n` +
    `User request:\n${parsed.data.prompt}`;

  // Which agent handles page-assist is configurable on the /pages surface
  // (the Assist panel picker → profiles.preferences.pagesAssistAgentSlug);
  // falls back to the default `pages` specialist seeded during onboarding.
  const agentSlug = await resolveAssistAgentSlug(user.id, 'pages');
  if (!agentSlug) {
    return NextResponse.json(
      {
        error:
          'No Pages assistant is set up yet. Pick one in the Assist panel, or finish onboarding to provision the default Pages specialist.',
      },
      { status: 409 },
    );
  }

  const result = await invokeAgent({
    ownerId: user.id,
    agentSlug,
    prompt: delegationPrompt,
    // The endpoint is the entry point — depth=1, no parent trace.
    depth: 1,
    parentTraceId: null,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  // Re-read after the agent's run so the diff reflects what just landed.
  // getPage's lazy backfill is idempotent — no extra writes if the agent's
  // block tools already produced id-bearing nodes (they do, via saveDraft
  // → ensureBlockIds).
  const after = await getPage(user.id, id);
  if (!after) return NextResponse.json({ error: 'page disappeared mid-run' }, { status: 500 });

  const diff = diffBlocks(
    after.doc as Record<string, unknown>,
    (after.draft as Record<string, unknown> | null) ?? (after.doc as Record<string, unknown>),
  );

  // Every block id that now differs from the committed doc (added or changed).
  // The editor highlights these green so the user can see what Pages touched —
  // useful precisely because an edited block's text no longer matches what they
  // marked. Removed blocks have no current id to point at, so they're omitted.
  const changedBlockIds = diff.ordered
    .filter((c) => c.kind === 'added' || c.kind === 'changed')
    .map((c) => (c.kind === 'added' ? c.block.id : c.to.id))
    .filter((bid): bid is string => typeof bid === 'string' && bid.length > 0);

  return NextResponse.json({
    ok: true,
    reply: result.text,
    changedBlockIds,
    diff: {
      added: diff.added.length,
      removed: diff.removed.length,
      changed: diff.changed.length,
      unchangedCount: diff.unchangedCount,
      // First handful of changed/added previews — gives the panel something to
      // show under the chat without bloating the response. Full per-block
      // view is rendered separately from the GET that the panel refreshes.
      sample: diff.ordered.slice(0, 8).map((c) => {
        if (c.kind === 'added') return { kind: 'added' as const, id: c.block.id, blockKind: c.block.kind, preview: c.block.preview };
        if (c.kind === 'removed') return { kind: 'removed' as const, id: c.block.id, blockKind: c.block.kind, preview: c.block.preview };
        return {
          kind: 'changed' as const,
          id: c.to.id,
          blockKind: c.to.kind,
          fromPreview: c.from.preview,
          toPreview: c.to.preview,
        };
      }),
    },
    hasDraft: !!after.draft,
  });
}
