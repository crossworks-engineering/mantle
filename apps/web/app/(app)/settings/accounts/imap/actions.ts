'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { seal } from '@mantle/crypto';
import { db, emailAccounts } from '@mantle/db';
import { probeImapConnection } from '@mantle/email';
import { requireOwner } from '@/lib/auth';
import { accountBranchPath } from '@/lib/account-branch';

const FormSchema = z.object({
  address: z.string().email(),
  displayName: z.string().optional(),
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535).default(993),
  secure: z
    .union([z.literal('on'), z.literal('true'), z.literal('false'), z.boolean()])
    .transform((v) => v === true || v === 'on' || v === 'true'),
  password: z.string().min(1),
});

export type ImapFormResult =
  | { intent: 'test'; ok: true; foldersFound: number; folderSample: string[]; serverName?: string }
  | { intent: 'test'; ok: false; error: string }
  | { intent: 'save'; ok: false; error: string };
// Successful saves redirect, so there's no "save: ok=true" shape.

function parseForm(form: FormData) {
  return FormSchema.safeParse({
    address: form.get('address'),
    displayName: form.get('displayName') ?? undefined,
    host: form.get('host'),
    port: form.get('port'),
    secure: form.get('secure') ?? false,
    password: form.get('password'),
  });
}

function explainError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Tighten a few common IMAP errors into plain English.
  if (/authentication/i.test(raw)) return 'Authentication failed — check the email address and app password.';
  if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) return 'Could not resolve that host. Check the IMAP host.';
  if (/ECONNREFUSED/i.test(raw)) return 'Connection refused — wrong port, or the server isn\'t listening there.';
  if (/ETIMEDOUT|timeout/i.test(raw)) return 'Timed out connecting. Check the host, port, and TLS toggle.';
  if (/self.signed certificate|unable to verify/i.test(raw)) return 'TLS certificate problem. If you trust this host, try toggling TLS off and using a STARTTLS port.';
  return raw;
}

export async function handleImapForm(
  _prev: ImapFormResult | undefined,
  form: FormData,
): Promise<ImapFormResult> {
  const user = await requireOwner();
  const intent = String(form.get('intent') ?? 'save') as 'test' | 'save';

  const parsed = parseForm(form);
  if (!parsed.success) {
    return { intent, ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  }
  const { address, displayName, host, port, secure, password } = parsed.data;

  // Always probe — for `test` it's the whole point, for `save` it's a guardrail.
  let probe;
  try {
    probe = await probeImapConnection({ host, port, secure, user: address, pass: password });
  } catch (err) {
    return { intent, ok: false, error: explainError(err) };
  }

  if (intent === 'test') {
    return {
      intent: 'test',
      ok: true,
      foldersFound: probe.folders.length,
      // Show a handful so the user can confirm it's their account, not someone else's.
      folderSample: probe.folders.slice(0, 6),
      serverName: probe.serverGreeting,
    };
  }

  // intent === 'save'
  const sealed = seal(JSON.stringify({ password }), `imap:${user.id}:${address}`);

  await db
    .insert(emailAccounts)
    .values({
      userId: user.id,
      provider: 'imap',
      address,
      displayName: displayName ?? null,
      imapHost: host,
      imapPort: port,
      imapSecure: secure,
      imapConfigEnc: sealed.ciphertext,
      ingestPolicy: 'approve_list',
      branchPath: accountBranchPath(address),
    })
    .onConflictDoUpdate({
      target: [emailAccounts.userId, emailAccounts.address],
      set: {
        imapHost: host,
        imapPort: port,
        imapSecure: secure,
        imapConfigEnc: sealed.ciphertext,
        enabled: true,
        lastSyncError: null,
        // branchPath is *not* reset on re-connect — preserves the existing
        // ltree location for any mail already ingested under it.
      },
    });

  revalidatePath('/settings/accounts');
  redirect('/settings/accounts');
}
