import type { TelegramAttachment } from '@mantle/db';

/**
 * The shape `gate()` returns for a single inbound update.
 *
 * - `deliver` → message passed access checks; the worker inserts it.
 * - `pair`    → first DM from an unknown sender; we reply with a pairing code.
 * - `drop`    → silently ignored (denied, expired pairing, group not allowlisted).
 */
export type GateResult =
  | { action: 'deliver' }
  | { action: 'pair'; code: string; isResend: boolean }
  | { action: 'drop' };

/**
 * A parsed inline-keyboard tap from an approval card (the buttons
 * `sendApprovalCard` attaches). `callback_data` is `mantle:approve:<id>`
 * / `mantle:reject:<id>`; anything else is ignored.
 */
export interface ApprovalCallback {
  decision: 'approve' | 'reject';
  pendingId: string;
}

/** What the injected approval handler returns: whether the decision
 *  applied, plus a short human line shown in the edited card + toast. */
export interface ApprovalDecisionResult {
  ok: boolean;
  text: string;
}

/**
 * Optional callbacks the poll worker injects so transport-layer code
 * (this package) can act on inbound control events WITHOUT importing
 * `@mantle/tools` — that import would close a dependency cycle, since
 * tools already depends on telegram. The worker (apps/web) sits above
 * both and can wire the two together.
 */
export interface PollHandlers {
  /** Apply an approve/reject decision for the owner who taps the button. */
  onApproval?: (input: {
    ownerId: string;
    decision: 'approve' | 'reject';
    pendingId: string;
  }) => Promise<ApprovalDecisionResult>;
}

/** Normalised inbound message shape — what `sync` hands to the persistor. */
export interface InboundMessage {
  /** Telegram update_id (used as the dedupe + ack key). */
  updateId: number;
  /** Telegram message_id within the chat. */
  messageId: string;
  chatId: string;
  chatType: 'private' | 'group' | 'supergroup';
  chatTitle?: string;
  chatUsername?: string;
  fromUserId: string;
  fromUsername?: string;
  fromName?: string;
  text: string;
  sentAt: Date;
  attachments: TelegramAttachment[];
}
