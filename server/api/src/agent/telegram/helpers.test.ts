import { describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/telegram', () => ({
  accountById: vi.fn(async () => null),
  sendChatAction: vi.fn(async () => {}),
  sendMessage: vi.fn(async () => [1]),
}));

import { parseVoiceMarker, telegramCaption, toConversationAttachments } from './helpers';

describe('telegramCaption', () => {
  it('drops Telegram media placeholders, keeps real captions', () => {
    expect(telegramCaption('(photo)')).toBe('');
    expect(telegramCaption('(document: report.pdf)')).toBe('');
    expect(telegramCaption('(voice message)')).toBe('');
    expect(telegramCaption('  what is this?  ')).toBe('what is this?');
    expect(telegramCaption(null)).toBe('');
  });
});

describe('parseVoiceMarker', () => {
  it('strips a leading [VOICE] marker in any case and flags the request', () => {
    expect(parseVoiceMarker('[VOICE] hello there')).toEqual({
      reply: 'hello there',
      requestedVoice: true,
    });
    expect(parseVoiceMarker('  [voice]\nhi')).toEqual({ reply: 'hi', requestedVoice: true });
  });
  it('ignores a marker that is not the first content', () => {
    expect(parseVoiceMarker('she said [VOICE] later')).toEqual({
      reply: 'she said [VOICE] later',
      requestedVoice: false,
    });
  });
  it('a marker-only reply becomes empty', () => {
    expect(parseVoiceMarker('[VOICE]')).toEqual({ reply: '', requestedVoice: true });
  });
});

describe('toConversationAttachments', () => {
  it('maps kinds, drops stickers, attaches the file node only to photos/documents', () => {
    const out = toConversationAttachments(
      [
        { kind: 'photo', file_id: 'f1', mime: 'image/jpeg' },
        { kind: 'sticker', file_id: 's1' },
        { kind: 'voice', file_id: 'v1', mime: 'audio/ogg' },
        { kind: 'document', file_id: 'd1', name: 'report.pdf' },
        { kind: 'video_note', file_id: 'vn1' },
      ] as never,
      'node-9',
    );
    expect(out).toEqual([
      { kind: 'image', mime: 'image/jpeg', fileId: 'f1', nodeId: 'node-9' },
      { kind: 'voice', mime: 'audio/ogg', fileId: 'v1' },
      { kind: 'document', caption: 'report.pdf', fileId: 'd1', nodeId: 'node-9' },
      { kind: 'video', fileId: 'vn1' },
    ]);
  });
  it('is empty for no attachments', () => {
    expect(toConversationAttachments(null)).toEqual([]);
  });
});
