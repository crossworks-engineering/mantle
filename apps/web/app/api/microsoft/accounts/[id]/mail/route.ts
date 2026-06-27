import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getMailAccount, setMailEnabled } from '@mantle/microsoft';
import { getOwnerOr401 } from '@/lib/auth';

/** Whether Outlook mail sync is enabled for this account. Both helpers are
 *  owner-scoped, so a non-owned id reads as `{ enabled: false }`. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const mail = await getMailAccount(user.id, id);
  return NextResponse.json({ enabled: !!mail?.enabled });
}

const Body = z.object({ enabled: z.boolean() });

/** Enable/disable Outlook mail sync for the account. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input.' }, { status: 400 });
  const ok = await setMailEnabled(user.id, id, parsed.data.enabled);
  if (!ok) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
  return NextResponse.json({ enabled: parsed.data.enabled });
}
