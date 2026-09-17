import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { updateAgent } from '@/lib/agents';
import { updateAiWorker } from '@/lib/ai-workers';
import { buildComboDiff, COMBO_DEFS } from '@/lib/model-combos';
import { loadComboContext } from '@/lib/model-combos-context';
import { errorMessage } from '@mantle/std';
import { firstIssue } from '@/lib/zod-issue';

const Body = z.object({
  combo: z.enum(['best-advanced', 'cost-aware', 'cheapest', 'free']),
  /** Target ids ('agent:<uuid>' / 'worker:<uuid>') the owner unticked. */
  exclude: z.array(z.string()).max(200).default([]),
});

/**
 * Apply a named combination — the explicit one-shot. The diff is recomputed
 * server-side at apply time (never trusted from the client), rows the owner
 * excluded are skipped, and each write goes through the same updateAgent /
 * updateAiWorker paths the settings forms use, sequentially, so a failure
 * attributes to its row. Nothing here is automatic or scheduled — this
 * endpoint only ever runs from the owner's confirm dialog.
 */
export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: firstIssue(parsed.error, 'Invalid input.') },
      { status: 400 },
    );
  }
  const def = COMBO_DEFS.find((d) => d.key === parsed.data.combo)!;
  const ctx = await loadComboContext(user.id);
  const diff = buildComboDiff(def.key, ctx.entries, ctx.targets, ctx.keyIdByService);
  const excluded = new Set(parsed.data.exclude);

  const applied: string[] = [];
  const skipped: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const t of diff) {
    if (!t.changed || !t.next || excluded.has(t.id)) {
      if (t.changed || t.reason) skipped.push(t.id);
      continue;
    }
    const rowId = t.id.split(':')[1]!;
    try {
      if (t.targetKind === 'agent') {
        await updateAgent(user.id, rowId, {
          provider: t.next.provider,
          model: t.next.model,
          apiKeyId: t.next.apiKeyId,
        });
      } else {
        await updateAiWorker(user.id, rowId, {
          provider: t.next.provider,
          model: t.next.model,
          apiKeyId: t.next.apiKeyId,
        });
      }
      applied.push(t.id);
    } catch (err) {
      failed.push({ id: t.id, error: errorMessage(err) });
    }
  }
  return NextResponse.json({ combo: def.key, applied, skipped, failed });
}
