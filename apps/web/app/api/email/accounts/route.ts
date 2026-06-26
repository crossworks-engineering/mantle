import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  connectImapAccount,
  latestSyncRuns,
  listAccounts,
  redactAccount,
} from '@mantle/email';
import { requireOwner } from '@/lib/auth';

/** List the owner's email accounts plus the latest sync run per account. The
 *  sealed IMAP credential is stripped before it leaves the process. */
export async function GET() {
  const user = await requireOwner();
  const [accounts, runs] = await Promise.all([listAccounts(user.id), latestSyncRuns(user.id)]);
  return NextResponse.json({
    accounts: accounts.map(redactAccount),
    latestRuns: Object.fromEntries(runs),
  });
}

const ConnectBody = z.object({
  intent: z.enum(['test', 'save']).default('save'),
  address: z.string().email(),
  displayName: z.string().nullish(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  password: z.string().optional(),
  firstScanDays: z.number().int().min(1).max(3650).default(365),
  smtpHost: z.string().min(1).nullish(),
  smtpPort: z.number().int().min(1).max(65535).nullish(),
  smtpSecure: z.boolean().default(true),
});

/** Connect a new IMAP account. `intent: 'test'` probes only; `'save'` persists. */
export async function POST(req: Request) {
  const user = await requireOwner();
  const parsed = ConnectBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  const { intent, ...input } = parsed.data;
  const result = await connectImapAccount(user.id, intent, input);
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}
