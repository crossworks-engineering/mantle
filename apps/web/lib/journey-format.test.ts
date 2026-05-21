import { describe, expect, it } from 'vitest';
import { deriveAction, sourceLabel } from './journey-format';

describe('deriveAction', () => {
  it('labels an ingested email from its node type', () => {
    const a = deriveAction({ kind: 'extractor_run', nodeType: 'email', mime: null, source: null });
    expect(a).toEqual({ label: 'Email ingested', category: 'content', iconKey: 'email' });
  });

  it('prefers the explicit human source over the node type', () => {
    const a = deriveAction({
      kind: 'extractor_run',
      nodeType: 'file',
      mime: 'application/pdf',
      source: 'assistant_upload',
    });
    expect(a.label).toBe('Uploaded in chat');
    expect(a.category).toBe('content');
    expect(a.iconKey).toBe('pdf');
  });

  it('falls back to a pdf label + icon when there is no source', () => {
    const a = deriveAction({
      kind: 'extractor_run',
      nodeType: 'file',
      mime: 'application/pdf',
      source: null,
    });
    expect(a).toEqual({ label: 'PDF ingested', category: 'content', iconKey: 'pdf' });
  });

  it('detects images by mime', () => {
    const a = deriveAction({ kind: 'photo_ingest', nodeType: 'file', mime: 'image/heic', source: null });
    expect(a.iconKey).toBe('image');
    expect(a.label).toBe('Image ingested');
  });

  it('maps note creation', () => {
    const a = deriveAction({ kind: 'extractor_run', nodeType: 'note', mime: null, source: 'note_create' });
    expect(a).toEqual({ label: 'Wrote a note', category: 'content', iconKey: 'note' });
  });

  it('classifies dialog turns', () => {
    const a = deriveAction({ kind: 'responder_turn', nodeType: null, mime: null, source: null });
    expect(a).toEqual({ label: 'Conversation turn', category: 'dialog', iconKey: 'chat' });
  });

  it('treats telegram_message nodes as dialog, not content, even on extractor_run', () => {
    // A voice note: extractor fires on the node but it's conversation, not
    // filed content — must not be mislabelled "Content added".
    const a = deriveAction({
      kind: 'extractor_run',
      nodeType: 'telegram_message',
      mime: null,
      source: null,
    });
    expect(a).toEqual({ label: 'Telegram message', category: 'dialog', iconKey: 'telegram' });
  });

  it('classifies background work as automation', () => {
    expect(deriveAction({ kind: 'reflector_run', nodeType: null, mime: null, source: null }).category).toBe(
      'automation',
    );
    expect(deriveAction({ kind: 'summarizer_run', nodeType: null, mime: null, source: null }).category).toBe(
      'automation',
    );
    expect(deriveAction({ kind: 'heartbeat_fire', nodeType: null, mime: null, source: null }).category).toBe(
      'automation',
    );
  });
});

describe('sourceLabel', () => {
  it('humanises known sources', () => {
    expect(sourceLabel('assistant_upload')).toBe('chat upload');
    expect(sourceLabel('telegram_upload')).toBe('telegram upload');
    expect(sourceLabel('note_create')).toBe('notes');
  });

  it('falls back to the raw source or "system"', () => {
    expect(sourceLabel('weird_source')).toBe('weird_source');
    expect(sourceLabel(null)).toBe('system');
  });
});
