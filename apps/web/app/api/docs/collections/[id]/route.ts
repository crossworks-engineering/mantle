import { NextResponse } from 'next/server';
import { z } from 'zod';
import { setCollectionEnabled } from '@mantle/files';
import { getOwnerOr401 } from '@/lib/auth';

const Body = z.object({ enabled: z.boolean() });

/**
 * Flip one collection. Enabling reconciles immediately; disabling purges its
 * indexed nodes. Returns {ok,message} (200) summarising what happened.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const owner = await getOwnerOr401();
  if (owner instanceof Response) return owner;
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
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
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
