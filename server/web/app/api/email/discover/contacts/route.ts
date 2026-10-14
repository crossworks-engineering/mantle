import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { addContactFromSender } from '@mantle/email';
import { ownerCaller } from '@/lib/auth';
import { readBody } from '@/lib/read-body';

const Body = z.object({
  address: z.string().email(),
  displayName: z.string().optional(),
});

/** Promote a discovered sender to a contact + trigger their 90-day backfill. */
export async function POST(req: Request) {
  const user = ownerCaller();
  const body = await readBody(req, Body);
  const result = await addContactFromSender(user.id, body.address, body.displayName);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
