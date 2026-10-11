import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { connectImapAccount, getAccount, redactAccount } from '@mantle/email';
import { getOwnerOr401 } from '@/lib/auth';
import { vaultPairRefusalFor } from '@/lib/tools';
import { firstIssue } from '@/lib/zod-issue';

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

/** The refusal of a host or port change that would reuse the stored password. */
const MAIL_HOST_NEEDS_PASSWORD =
  "This moves the account's IMAP or SMTP host or port, and a blank password would send the stored one there: re-enter the app password with the new host, or ask a user with the keys area to make this change.";

const sameHost = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

/**
 * Whether `input` points the account's sealed password at a host or port
 * other than the stored ones (W7a fix round 5): the IMAP host or port, or an
 * SMTP host or port set and different. Removing the SMTP server sends
 * nothing anywhere.
 */
function mailDestinationMoved(
  stored: {
    imapHost: string | null;
    imapPort: number | null;
    smtpHost: string | null;
    smtpPort: number | null;
  },
  input: { host: string; port: number; smtpHost?: string | null; smtpPort?: number | null },
): boolean {
  if (!sameHost(input.host, stored.imapHost) || input.port !== stored.imapPort) return true;
  if (input.smtpHost && !sameHost(input.smtpHost, stored.smtpHost)) return true;
  return input.smtpPort != null && input.smtpPort !== stored.smtpPort;
}

/**
 * Edit an existing IMAP account. `intent: 'test'` probes only; `'save'` persists.
 *
 * A blank password reuses the sealed one, and the probe (test or save) sends
 * it to the host and port in the body. That is a vault secret paired with a
 * host of the writer's choosing (W7a fix round 5, @mantle/tools
 * secret-ref-gate.ts): with a host or port other than the stored ones, the
 * password must be typed again, unless the login holds the keys area.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const parsed = EditBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const { intent, ...input } = parsed.data;
  if (!input.password) {
    const stored = await getAccount(user.id, id);
    if (stored && mailDestinationMoved(stored, input) && (await vaultPairRefusalFor(user))) {
      return NextResponse.json({ ok: false, error: MAIL_HOST_NEEDS_PASSWORD }, { status: 403 });
    }
  }
  const result = await connectImapAccount(user.id, intent, { ...input, accountId: id });
  if (!result.ok) {
    return NextResponse.json(result, { status: result.error === 'Account not found.' ? 404 : 400 });
  }
  return NextResponse.json(result);
}
