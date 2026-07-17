export * from './types';
// Re-export the row types web pages need, so they don't reach into @mantle/db
// directly (keeps the frontend free of a direct DB dependency).
export type { EmailAccount, SyncRun, Email } from '@mantle/db';
export * from './addresses';
export { classifyDelivery, salienceForDeliveryKind } from './classify';
export type { ClassifyInput, DeliveryKind } from './classify';
export { syncAccount, backfillMatch } from './sync';
export {
  enqueueBackfill,
  enqueueBackfills,
  BACKFILL_QUEUE,
  MS_BACKFILL_QUEUE,
} from './backfill-queue';
export {
  peekLatestFromSender,
  peekRecentSenders,
  type SenderPreview,
  type RecentSender,
} from './peek';
export { sanitizeEmailHtml } from './render';
export {
  imap,
  probeImapConnection,
  unsealImapPassword,
  reclassifyByRefs,
  decodeMsgId,
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
export {
  accountBranchPath,
  redactAccount,
  type PublicEmailAccount,
  listAccounts,
  listImapAccounts,
  getAccount,
  latestSyncRuns,
  saveImapAccount,
  connectImapAccount,
  explainImapError,
  listAccountFolders,
  setIncludedFolders,
  type SaveImapAccountInput,
  type SaveImapAccountResult,
  type ConnectImapInput,
  type ConnectImapResult,
  type AccountFoldersResult,
} from './accounts';
export {
  INBOX_LIMIT,
  navAccounts,
  folderFacets,
  listMessages,
  getMessageWithAttachments,
  setReadStatus,
  setStarred,
  type NavAccount,
  type FolderFacet,
  type ListMessagesInput,
  type MessageListItem,
} from './messages';
export {
  recentUnknownSenders,
  addContactFromSender,
  type UnknownSender,
  type RecentUnknownResult,
  type AddSenderResult,
  type PeekProviderResolver,
} from './discover';
