export * from './types';
export * from './addresses';
export { SenderResolver, upsertSenders } from './decisions';
export type { Decision } from './decisions';
export { syncAccount, backfillSender } from './sync';
export { peekLatestFromSender, type SenderPreview } from './peek';
export { sanitizeEmailHtml } from './render';
export { imap, probeImapConnection, type ImapProbeResult } from './providers/imap';
