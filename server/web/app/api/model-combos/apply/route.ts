import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { getAgent, updateAgent } from '@/lib/agents';
import { getAiWorker, updateAiWorker } from '@/lib/ai-workers';
import { AGENT_ROUTES, modelRoutesRefusal, modelRoutesStamp } from '@/lib/model-route-pair';
import { buildComboDiff, COMBO_DEFS } from '@/lib/model-combos';
import { loadComboContext } from '@/lib/model-combos-context';
import { itemErrorText } from '@mantle/std';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';

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
  const user = ownerCaller();
  const parsed = Body.safeParse(await readJson(req));
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
      // A new key or provider (whose vault key a route without a key id
      // falls back to) on a route with a base URL of someone's choosing is
      // the keys area's, and the row records who paired them (W7a fix
      // rounds 4 and 5, lib/model-route-pair.ts).
      const stored =
        t.targetKind === 'agent'
          ? await getAgent(user.id, rowId)
          : await getAiWorker(user.id, rowId);
      const route = { provider: t.next.provider, apiKeyId: t.next.apiKeyId };
      const before = stored as Record<string, unknown> | null;
      const refused = await modelRoutesRefusal(user, before, route, AGENT_ROUTES);
      if (refused) {
        failed.push({ id: t.id, error: refused });
        continue;
      }
      const patch = {
        provider: t.next.provider,
        model: t.next.model,
        apiKeyId: t.next.apiKeyId,
        ...modelRoutesStamp(user, before, route, AGENT_ROUTES),
      };
      if (t.targetKind === 'agent') {
        await updateAgent(user.id, rowId, patch);
      } else {
        await updateAiWorker(user.id, rowId, patch);
      }
      applied.push(t.id);
    } catch (err) {
      // A domain refusal says its text; a fault is logged and the item says
      // so (fix round 1, L5), never the error's own text.
      failed.push({
        id: t.id,
        error: itemErrorText(
          err,
          'model-combos/apply',
          'Could not apply the change. The details are in the server log.',
        ),
      });
    }
  }
  return NextResponse.json({ combo: def.key, applied, skipped, failed });
}
