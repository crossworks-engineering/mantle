import { eq } from 'drizzle-orm';
import { db, telegramAccounts, type TelegramAccount } from '@mantle/db';
import { InputFile } from 'grammy';
import type { ReactionTypeEmoji } from 'grammy/types';
import { botFor } from './client';

const MAX_CHUNK = 4096;

/**
 * Sends a chat message to `chatId` from the given account, splitting on
 * 4096-char chunks. Returns Telegram message_ids for the sent parts.
 */
export async function sendMessage(
  account: TelegramAccount,
  chatId: string,
  text: string,
  options?: { replyTo?: string; markdown?: boolean },
): Promise<number[]> {
  const bot = await botFor(account);
  const chunks = chunkText(text, MAX_CHUNK);
  const replyTo = options?.replyTo != null ? Number(options.replyTo) : undefined;
  const parseMode = options?.markdown ? ('MarkdownV2' as const) : undefined;
  const ids: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const sent = await bot.api.sendMessage(chatId, chunks[i]!, {
      ...(replyTo != null && i === 0
        ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
        : {}),
      ...(parseMode ? { parse_mode: parseMode } : {}),
    });
    ids.push(sent.message_id);
  }
  return ids;
}

/**
 * Send a voice note (the bubble-style voice message that renders with a
 * waveform + play button in Telegram). The audio buffer must be
 * OGG/Opus — Telegram refuses other formats for `sendVoice`. Our
 * upstream is OpenAI TTS with `response_format='opus'` which produces
 * exactly the right container.
 *
 * Optional `caption` rides along with the voice note, useful for
 * including the source transcript so the user can read in parallel
 * (or copy/quote without re-listening). Most assistants keep this
 * empty; we expose it for the cases where it matters.
 *
 * Returns the Telegram message_id so the caller can persist it on the
 * outbound `telegram_messages` row.
 */
/**
 * Send a generated image to `chatId` as a photo (full-size, inline
 * preview in the chat). Telegram's sendPhoto enforces a 10 MB cap on
 * uploads-by-bytes; if we ever generate larger we'd switch to
 * sendDocument so the file doesn't get rejected at the boundary —
 * for now AI-generated 1024x1024 PNGs sit comfortably under that.
 *
 * Caption rides along (max 1024 chars per Telegram limit; we slice
 * defensively). Useful for showing the prompt + model that produced
 * the image so the user can sanity-check what generated it.
 *
 * Returns the Telegram message_id so the caller can persist it on
 * the outbound `telegram_messages` row alongside the file node.
 */
export async function sendPhoto(
  account: TelegramAccount,
  chatId: string,
  image: Buffer,
  options?: {
    replyTo?: string;
    caption?: string;
    filename?: string;
  },
): Promise<number> {
  const bot = await botFor(account);
  const replyTo = options?.replyTo != null ? Number(options.replyTo) : undefined;
  const filename = options?.filename ?? 'image.png';
  const sent = await bot.api.sendPhoto(chatId, new InputFile(image, filename), {
    ...(replyTo != null
      ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
      : {}),
    ...(options?.caption ? { caption: options.caption.slice(0, 1024) } : {}),
  });
  return sent.message_id;
}

export async function sendVoice(
  account: TelegramAccount,
  chatId: string,
  audio: Buffer,
  options?: {
    replyTo?: string;
    caption?: string;
    durationSeconds?: number;
    filename?: string;
  },
): Promise<number> {
  const bot = await botFor(account);
  const replyTo = options?.replyTo != null ? Number(options.replyTo) : undefined;
  const filename = options?.filename ?? 'voice.ogg';
  const sent = await bot.api.sendVoice(chatId, new InputFile(audio, filename), {
    ...(replyTo != null
      ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
      : {}),
    ...(options?.caption ? { caption: options.caption.slice(0, 1024) } : {}),
    ...(typeof options?.durationSeconds === 'number'
      ? { duration: Math.round(options.durationSeconds) }
      : {}),
  });
  return sent.message_id;
}

/**
 * Download a file from Telegram by its file_id. Two-step in the Bot
 * API: getFile returns a `file_path` that's valid for ~1 hour; we then
 * fetch the raw bytes from the file CDN. Returns the buffer plus the
 * MIME we can pass to Whisper (sniffed from the file_path extension
 * since Telegram doesn't echo Content-Type reliably).
 *
 * Throws on:
 *   - file_id expired / unknown
 *   - download non-2xx
 *   - downloaded file_path missing (rare; Telegram quirk)
 */
export async function downloadTelegramFile(
  account: TelegramAccount,
  fileId: string,
): Promise<{ bytes: Buffer; mimeType: string; filename: string }> {
  const bot = await botFor(account);
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error(`telegram getFile: no file_path returned for ${fileId}`);
  }
  // The plaintext bot token sits inside `bot.token`. We assemble the
  // CDN URL ourselves rather than going through grammy's `download()`
  // because we want bytes in memory, not on disk — the buffer goes
  // straight to MinIO + Whisper.
  const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`telegram file download ${res.status}: ${file.file_path}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const filename = file.file_path.split('/').pop() ?? 'voice.ogg';
  // Prefer the extension; fall back to sniffing the magic bytes when it's
  // unknown. Telegram photos come back as `.jpg` here, but documents and
  // odd file_paths can be extensionless — the byte sniff catches those so
  // the vision adapter (which rejects octet-stream) always gets a real
  // image mime.
  let mimeType = mimeFromFilename(filename);
  if (mimeType === 'application/octet-stream') {
    mimeType = sniffImageMime(bytes) ?? mimeType;
  }
  return { bytes, mimeType, filename };
}

export function mimeFromFilename(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  // Audio (voice notes → Whisper).
  if (ext === 'ogg' || ext === 'oga' || ext === 'opus') return 'audio/ogg';
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'm4a' || ext === 'aac') return 'audio/aac';
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'webm') return 'audio/webm';
  if (ext === 'flac') return 'audio/flac';
  // Images (photos → vision). Telegram photos are JPEG.
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'application/octet-stream';
}

/** Detect a common image type from its leading magic bytes. Returns null
 *  if the buffer isn't a recognised image. Used as a fallback when the
 *  Telegram file_path has no usable extension. */
export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  // GIF: 'GIF8'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  // WEBP: 'RIFF' .... 'WEBP'
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Send a chat action (the native "Bot is typing…" / "recording voice…"
 * indicator). Telegram auto-clears it after ~5s or when the next message
 * arrives, so callers repeat it (~every 4s) to keep it alive across a
 * long generation. Fire-and-forget — failures are non-fatal.
 */
export async function sendChatAction(
  account: TelegramAccount,
  chatId: string,
  action: 'typing' | 'upload_photo' | 'record_voice' | 'upload_voice' | 'upload_document' = 'typing',
): Promise<void> {
  const bot = await botFor(account);
  await bot.api.sendChatAction(chatId, action);
}

export async function reactToMessage(
  account: TelegramAccount,
  chatId: string,
  messageId: string,
  emoji: string,
): Promise<void> {
  const bot = await botFor(account);
  await bot.api.setMessageReaction(chatId, Number(messageId), [
    { type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] },
  ]);
}

export async function editMessage(
  account: TelegramAccount,
  chatId: string,
  messageId: string,
  text: string,
  options?: { markdown?: boolean },
): Promise<void> {
  const bot = await botFor(account);
  const parseMode = options?.markdown ? ('MarkdownV2' as const) : undefined;
  await bot.api.editMessageText(
    chatId,
    Number(messageId),
    text,
    ...(parseMode ? [{ parse_mode: parseMode }] : []),
  );
}

/**
 * Lookup helper for tools that get `chat_id` (Telegram's id) but need the
 * underlying account. Picks the first enabled account that has seen this
 * chat — good enough for v1 since users typically run one bot.
 */
export async function accountForChat(_chatId: string): Promise<TelegramAccount | null> {
  // For now, just return the first enabled account; multi-bot routing comes
  // later. Lookup is by chat would require a join through telegram_chats,
  // and we'd need to handle the "chat hasn't been seen yet" case anyway.
  const [account] = await db
    .select()
    .from(telegramAccounts)
    .where(eq(telegramAccounts.enabled, true))
    .limit(1);
  return account ?? null;
}

/**
 * The account (bot) a known message arrived on. Inbound rows carry the
 * `account_id` of the bot that received them, so replies + file downloads use
 * the *same* bot — the multi-bot-correct counterpart to `accountForChat`'s
 * "first enabled" shortcut.
 */
export async function accountById(id: string): Promise<TelegramAccount | null> {
  const [account] = await db
    .select()
    .from(telegramAccounts)
    .where(eq(telegramAccounts.id, id))
    .limit(1);
  return account ?? null;
}

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit);
    const line = rest.lastIndexOf('\n', limit);
    const space = rest.lastIndexOf(' ', limit);
    const cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) out.push(rest);
  return out;
}
