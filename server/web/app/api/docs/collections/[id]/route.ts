import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { setCollectionEnabled } from '@mantle/files';
import { ownerCaller } from '@/lib/auth';
import { publicErrorMessage } from '@mantle/std';
import { readJson } from '@/lib/read-body';

const Body = z.object({ enabled: z.boolean() });

/**
 * Flip one collection. Enabling reconciles immediately; disabling purges its
 * indexed nodes. Returns {ok,message} (200) summarising what happened.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const owner = ownerCaller();
  const { id } = await params;
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) return NextResponse.json({ ok: false, message: 'invalid input' });
  const enabled = parsed.data.enabled;
  try {
    const res = await setCollectionEnabled(owner.id, id, enabled);
    if (!res) return NextResponse.json({ ok: false, message: 'Collection not found.' });
    if (enabled && res.reconciled) {
      const r = res.reconciled;
      return NextResponse.json({
        ok: true,
        message: `Indexed ${res.collection.label}: +${r.inserted} new, ${r.updated} updated, ${r.noop} unchanged.`,
      });
    }
    return NextResponse.json({
      ok: true,
      message: `Disabled ${res.collection.label} — removed ${res.purged ?? 0} indexed doc(s).`,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      message: publicErrorMessage(err, 'docs collection'),
    });
  }
}
