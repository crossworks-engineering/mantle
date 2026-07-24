import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { connectImapAccount, getAccount, redactAccount } from '@mantle/email';
import { getOwnerOr401 } from '@/lib/auth';

/** One owner-scoped account (credential stripped). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const account = await getAccount(user.id, id);
  if (!account) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
  return NextResponse.json({ account: redactAccount(account) });
}

const EditBody = z.object({
  intent: z.enum(['test', 'save']).default('save'),
  // address is fixed on edit (the stored one is the identity) — accepted but unused.
  displayName: z.string().nullish(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  // Blank/omitted keeps the stored password.
  password: z.string().optional(),
  firstScanDays: z.number().int().min(1).max(3650).default(365),
  smtpHost: z.string().min(1).nullish(),
  smtpPort: z.number().int().min(1).max(65535).nullish(),
  smtpSecure: z.boolean().default(true),
});

/** Edit an existing IMAP account. `intent: 'test'` probes only; `'save'` persists. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const parsed = EditBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  const { intent, ...input } = parsed.data;
  const result = await connectImapAccount(user.id, intent, { ...input, accountId: id });
  if (!result.ok) {
    return NextResponse.json(result, { status: result.error === 'Account not found.' ? 404 : 400 });
  }
  return NextResponse.json(result);
}
