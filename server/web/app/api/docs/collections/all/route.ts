import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listDocCollections, setCollectionEnabled } from '@mantle/files';
import { getOwnerOr401 } from '@/lib/auth';

const Body = z.object({ enabled: z.boolean() });

/** Enable or disable every collection at once. */
export async function POST(req: Request) {
  const owner = await getOwnerOr401();
  if (owner instanceof Response) return owner;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, message: 'invalid input' });
  const enabled = parsed.data.enabled;
  try {
    const cols = await listDocCollections(owner.id);
    let changed = 0;
    for (const c of cols) {
      if (c.enabled !== enabled) {
        await setCollectionEnabled(owner.id, c.id, enabled);
        changed++;
      }
    }
    return NextResponse.json({
      ok: true,
      message:
        changed === 0
          ? `All collections already ${enabled ? 'enabled' : 'disabled'}.`
          : `${enabled ? 'Enabled' : 'Disabled'} ${changed} collection(s).`,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
