export * from './types';
export * from './addresses';
export { SenderResolver, upsertSenders } from './decisions';
export type { Decision } from './decisions';
export { syncAccount, backfillSender } from './sync';
export { peekLatestFromSender, type SenderPreview } from './peek';
export { sanitizeEmailHtml } from './render';
export {
  imap,
  probeImapConnection,
  unsealImapPassword,
  type ImapProbeResult,
} from './providers/imap';
export {
  sendEmail,
  probeSmtpConnection,
  accountCanSend,
  type SendEmailInput,
  type SendEmailResult,
  type EmailAttachment,
} from './send';
