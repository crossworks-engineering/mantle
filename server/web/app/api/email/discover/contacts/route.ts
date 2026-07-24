import { NextResponse } from 'next/server';
import { z } from 'zod';
import { addContactFromSender } from '@mantle/email';
import { getOwnerOr401 } from '@/lib/auth';

const Body = z.object({
  address: z.string().email(),
  displayName: z.string().optional(),
});

/** Promote a discovered sender to a contact + trigger their 90-day backfill. */
export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  const result = await addContactFromSender(user.id, parsed.data.address, parsed.data.displayName);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
