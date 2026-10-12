/**
 * Old client sign-in code mails must never enter the brain: a code in the
 * corpus is a code the agents can read and repeat. Email-code sign-in went
 * in workspaces W8a and no code mail is sent any more, but the copies the
 * brain sent before stay in mailboxes (a Sent folder, Gmail's All Mail), and
 * a reply or forward quotes one. Every code mail carried a marker in its
 * Message-ID (and an X-Mantle-Client-Code header), which every folder and
 * every copy keeps, and the sync skips a message with it before anything is
 * fetched or stored (`ingestOne` in sync.ts).
 */
const MARKER = 'mantle-client-code.';

/** True for a client sign-in code mail, by its Message-ID (with or without
 *  angle brackets, any case). */
export function isClientCodeMail(message: { rfcMessageId?: string | null }): boolean {
  const id = message.rfcMessageId?.trim().replace(/^</, '').toLowerCase();
  return !!id && id.startsWith(MARKER);
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
 *  code into the brain (a member invite's code is live still). */
export function redactSigninCodes<T extends string | null | undefined>(text: T): T {
  if (!text) return text;
  return text.replace(SIGNIN_CODE_IN_LINK, '$1[redacted]') as T;
}
