/**
 * Telegram turn: the inbound row as the sequencer selects it, and the
 * attachment context the ingest stage hands to the responder stage.
 * Split out of runtime.ts on 2026-09-02 (audit, bloat B2).
 */
import type { TelegramAttachment } from '@mantle/db';

export interface InboundRow {
  id: string;
  processed: boolean;
  direction: string;
  chatPk: string;
  text: string;
  sentAt: Date;
  telegramChatId: string;
  telegramMessageId: string | null;
  fromName: string | null;
  accountId: string;
  responderAgentId: string | null;
  channelAgentId: string | null | undefined;
  /** The bot's own agent's level (its channel's agent), read now, so an
   *  agent lowered after pairing is caught (access matrix T21). */
  channelAgentAudience?: string | null;
  /** The chat's allowlist state now: a chat turned off after its message
   *  was queued (deleting its pinned agent does that) gets no reply. */
  allowlistStatus?: string;
  attachments: TelegramAttachment[] | null;
}

export type FileAttachment = TelegramAttachment & { file_id: string };

export interface AttachmentContext {
  kind: 'image' | 'file';
  transcript: string;
  note: string | null;
  nodeId: string | null;
  bytes: Buffer;
  mimeType: string;
  filename: string | null;
}
