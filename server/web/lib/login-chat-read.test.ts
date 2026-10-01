import { describe, expect, it } from 'vitest';
import { parseReadBody } from './login-chat-read';

describe('parseReadBody (POST /api/member/chat/read, /api/client/chat/read)', () => {
  it('no body, an empty body or a null `at` means now', () => {
    for (const body of [null, undefined, {}, { at: null }]) {
      expect(parseReadBody(body)).toEqual({ ok: true });
    }
  });

  it('takes an ISO time', () => {
    const res = parseReadBody({ at: '2026-10-01T09:00:00.000Z' });
    expect(res).toEqual({ ok: true, at: new Date('2026-10-01T09:00:00.000Z') });
  });

  it('refuses anything else', () => {
    for (const body of [[], 'x', 5, { at: 5 }, { at: 'yesterday' }, { at: 'x'.repeat(100) }]) {
      expect(parseReadBody(body)).toEqual({ ok: false, error: 'invalid_body' });
    }
  });
});
