export * from './types';
// Re-export the row types web pages need, so they don't reach into @mantle/db
// directly (keeps the frontend free of a direct DB dependency).
export type { EmailAccount, SyncRun, Email } from '@mantle/db';
export * from './addresses';
export { classifyDelivery, salienceForDeliveryKind } from './classify';
export type { ClassifyInput, DeliveryKind } from './classify';
export { sanitizeEmailHtml } from './render';
export {
  accountBranchPath,
  redactAccount,
  type PublicEmailAccount,
  listAccounts,
  getAccount,
  latestSyncRuns,
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
export { isClientCodeMail, redactSigninCodes, touchesClientCodeMail } from './client-code-mail';
export {
  mailboxOf,
  saveMailbox,
  disableMailbox,
  gateEnvelopes,
  ingestWireMessage,
  recordMailRun,
  ensureBranchPath,
} from './ingest';
export * from './wire';
export {
  sendViaSync,
  enqueueBackfills,
  SyncOffError,
  SyncSendError,
  SyncAdminError,
  syncAdmin,
  EmailSendPolicyOffError,
  EMAIL_SEND_POLICY_OFF_CODE,
  type SyncSendInput,
  type SyncSendResult,
} from './sync-client';
