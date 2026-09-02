/**
 * Telegram turn: small pure helpers and the two transport conveniences the
 * sequencer needs (typing keep-alive, best-effort apology). Split out of
 * runtime.ts on 2026-09-02 (audit, bloat B2); the pure ones are tested in
 * helpers.test.ts.
 */
import type { ConversationAttachment, TelegramAccount, TelegramAttachment } from '@mantle/db';
import { accountById, sendChatAction, sendMessage } from '@mantle/telegram';
import type { InboundRow } from './types';

/** Telegram fills a media message's text with a placeholder like "(photo)" or
 *  "(document: report.pdf)" when there's no real caption. Treat those as empty
 *  so they don't become the user's "question". */
export function telegramCaption(text: string | null | undefined): string {
  const t = (text ?? '').trim();
  if (!t || /^\((photo|document|voice message|audio|video|video_note|sticker)\b/i.test(t))
    return '';
  return t;
}

/** Map a Telegram message's attachments to the unified conversation-stream
 *  shape so a turn renders its media in /assistant (Phase 5). `fileNodeId` is
 *  the ingested file node (photos/documents get one), surfaced so a future
 *  render can re-fetch the original. Stickers are dropped (no conversational
 *  value). Bytes are never stored — only the transport file_id + node id. */
export function toConversationAttachments(
  atts: TelegramAttachment[] | null | undefined,
  fileNodeId?: string | null,
): ConversationAttachment[] {
  const KIND: Record<string, ConversationAttachment['kind'] | undefined> = {
    photo: 'image',
    document: 'document',
    voice: 'voice',
    audio: 'audio',
    video: 'video',
    video_note: 'video',
    sticker: undefined,
  };
  const out: ConversationAttachment[] = [];
  for (const a of atts ?? []) {
    const kind = KIND[a.kind];
    if (!kind) continue;
    out.push({
      kind,
      ...(a.mime ? { mime: a.mime } : {}),
      ...(a.name ? { caption: a.name } : {}),
      ...(a.file_id ? { fileId: a.file_id } : {}),
      ...(fileNodeId && (a.kind === 'photo' || a.kind === 'document')
        ? { nodeId: fileNodeId }
        : {}),
    });
  }
  return out;
}

/** Opt-in voice signal: a responder can prefix its reply with a `[VOICE]`
 *  token to force TTS-out even when the user typed in. The token is stripped
 *  before send + persist so it never reaches the user or the timeline. Match
 *  is permissive (case-insensitive, optional whitespace) because LLMs love to
 *  capitalise inconsistently, and it has to be the FIRST non-whitespace
 *  content so a quoted phrase mid-reply never triggers it. An empty `reply`
 *  means the model emitted ONLY the marker. */
export function parseVoiceMarker(rawReply: string): { reply: string; requestedVoice: boolean } {
  const m = rawReply.match(/^\s*\[voice\]\s*/i);
  if (!m) return { reply: rawReply, requestedVoice: false };
  return { reply: rawReply.slice(m[0].length).trim(), requestedVoice: true };
}

/** Native Telegram "typing…" keep-alive. Telegram clears a chat action
 *  after ~5s, so we re-send every 4s until the returned stop() is called.
 *  Best-effort: send failures are swallowed so they never break a turn. */
export function startTyping(account: TelegramAccount, chatId: string): () => void {
  let stopped = false;
  const poke = () => {
    if (stopped) return;
    void sendChatAction(account, chatId, 'typing').catch(() => {});
  };
  poke();
  const timer = setInterval(poke, 4000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Tell the user something went wrong, threaded under their message.
 *  Best-effort on both lookups and the send: an apology must never throw. */
export async function sendApology(row: InboundRow, text: string): Promise<void> {
  const account = await accountById(row.accountId).catch(() => null);
  if (!account) return;
  await sendMessage(account, row.telegramChatId, text, {
    replyTo: row.telegramMessageId ?? undefined,
  }).catch(() => {});
}
