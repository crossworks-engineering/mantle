'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { connectImapAccount } from '@mantle/email';
import { requireOwner } from '@/lib/auth';

const FormSchema = z.object({
  // Present only when editing an existing account.
  accountId: z.string().uuid().optional(),
  // Optional because edit uses the stored address (the account identity).
  address: z.string().email().optional(),
  displayName: z.string().optional(),
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535).default(993),
  secure: z
    .union([z.literal('on'), z.literal('true'), z.literal('false'), z.boolean()])
    .transform((v) => v === true || v === 'on' || v === 'true'),
  // Optional: blank on edit means "keep the stored password".
  password: z.string().optional(),
  // How far back the first scan reaches, in days. Default ≈ the old 12 months.
  firstScanDays: z.coerce.number().int().min(1).max(3650).default(365),
  // SMTP submission (sending). Optional — leave host/port blank to keep the
  // account read-only. Same app password as IMAP. secure: TLS(465)/STARTTLS(587).
  smtpHost: z.string().min(1).optional(),
  smtpPort: z.coerce.number().int().min(1).max(65535).optional(),
  smtpSecure: z
    .union([z.literal('on'), z.literal('true'), z.literal('false'), z.boolean()])
    .transform((v) => v === true || v === 'on' || v === 'true'),
});

export type ImapFormResult =
  | { intent: 'test'; ok: true; foldersFound: number; folderSample: string[]; serverName?: string }
  | { intent: 'test'; ok: false; error: string }
  | { intent: 'save'; ok: false; error: string };
// Successful saves redirect, so there's no "save: ok=true" shape.

function parseForm(form: FormData) {
  return FormSchema.safeParse({
    accountId: form.get('accountId') || undefined,
    address: form.get('address') || undefined,
    displayName: form.get('displayName') ?? undefined,
    host: form.get('host'),
    port: form.get('port'),
    secure: form.get('secure') ?? false,
    password: form.get('password') || undefined,
    firstScanDays: form.get('firstScanDays'),
    smtpHost: form.get('smtpHost') || undefined,
    smtpPort: form.get('smtpPort') || undefined,
    smtpSecure: form.get('smtpSecure') ?? false,
  });
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
  const { accountId, address, displayName, host, port, secure, password, firstScanDays, smtpHost, smtpPort, smtpSecure } =
    parsed.data;

  // Probe + persist live in @mantle/email (shared with POST/PATCH /api/email/accounts).
  const result = await connectImapAccount(user.id, intent, {
    accountId,
    address,
    displayName,
    host,
    port,
    secure,
    password,
    firstScanDays,
    smtpHost,
    smtpPort,
    smtpSecure,
  });

  if (!result.ok) return { intent, ok: false, error: result.error };
  if (result.intent === 'test') {
    return {
      intent: 'test',
      ok: true,
      foldersFound: result.foldersFound,
      folderSample: result.folderSample,
      serverName: result.serverName,
    };
  }

  revalidatePath('/settings/accounts');
  redirect('/settings/accounts');
}
