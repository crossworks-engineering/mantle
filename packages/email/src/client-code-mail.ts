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

/** The sent-mail folders of an account: the ones the server flags `\Sent`
 *  (special use, any language) when it flags any; else by the usual English
 *  names ({@link sentFolderNames}). */
export function pickSentFolders(
  folders: readonly string[],
  flaggedSent: readonly string[] = [],
): string[] {
  const flagged = flaggedSent.filter((f) => folders.includes(f));
  return flagged.length > 0 ? [...new Set(flagged)] : sentFolderNames(folders);
}

/** The marker text a reply or forward of a code mail carries in its
 *  In-Reply-To or References header (the code mail's Message-ID). */
const MARKER_IN_HEADER = /(?:^|[<\s,])mantle-client-code\./i;

/** True for a message that IS a code mail or answers one: the Message-ID
 *  marker, the X-Mantle-Client-Code header, or the marker in In-Reply-To or
 *  References (a reply or forward quotes the code). */
export function touchesClientCodeMail(message: {
  rfcMessageId?: string | null;
  clientCodeHeader?: boolean;
  inReplyTo?: string | null;
  references?: string | null;
}): boolean {
  return (
    isClientCodeMail(message) ||
    message.clientCodeHeader === true ||
    MARKER_IN_HEADER.test(message.inReplyTo ?? '') ||
    MARKER_IN_HEADER.test(message.references ?? '')
  );
}

/** A sign-in code in a link (`/client-signin?code=…`, `/client-signin#code=…`,
 *  `/invite?code=…`, also after other parameters): the code is replaced. */
const SIGNIN_CODE_IN_LINK =
  /((?:client-signin|invite)(?:\?|#)(?:[^\s"'<>#]*?[&;])?code=)[A-Za-z0-9_%-]+/gi;

/** Ingested mail text with sign-in link codes blanked (client logins audit
 *  K6): a link an admin mailed from a synced mailbox must not bring a live
 *  code into the brain. */
export function redactSigninCodes<T extends string | null | undefined>(text: T): T {
  if (!text) return text;
  return text.replace(SIGNIN_CODE_IN_LINK, '$1[redacted]') as T;
}
