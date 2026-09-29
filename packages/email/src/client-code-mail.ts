import { randomUUID } from 'node:crypto';

/**
 * Client sign-in code mails (client logins C2b) must never enter the brain:
 * a live code in the corpus is a code the agents can read and repeat. The
 * sign-in sender's sent-mail folders are left out of sync when it is chosen,
 * but a provider can keep a copy elsewhere too (Gmail files every sent mail
 * in All Mail). So every code mail carries a marker in its Message-ID, which
 * every folder and every copy keeps, and the sync skips a message with it
 * before anything is fetched or stored (`ingestOne` in sync.ts).
 */
const MARKER = 'mantle-client-code.';

/** The Message-ID for one code mail, angle brackets included. */
export function clientCodeMessageId(senderAddress: string): string {
  const domain = senderAddress.split('@')[1]?.trim() || 'mantle.invalid';
  return `<${MARKER}${randomUUID()}@${domain}>`;
}

/** The header every code mail carries as well (a second, human-readable
 *  sign in a mail client; the sync reads the Message-ID). */
export const CLIENT_CODE_HEADER = 'X-Mantle-Client-Code';

/** True for a client sign-in code mail, by its Message-ID (with or without
 *  angle brackets, any case). */
export function isClientCodeMail(message: { rfcMessageId?: string | null }): boolean {
  const id = message.rfcMessageId?.trim().replace(/^</, '').toLowerCase();
  return !!id && id.startsWith(MARKER);
}

/** Folder names that hold sent mail, by the usual names (any level, any
 *  case): Sent, Sent Items, Sent Mail, Sent Messages, INBOX.Sent,
 *  [Gmail]/Sent Mail. */
export function sentFolderNames(folders: readonly string[]): string[] {
  return folders.filter((f) => {
    const leaf = f.split(/[./]/).pop() ?? f;
    return /^sent( (items|mail|messages))?$/i.test(leaf.trim());
  });
}
