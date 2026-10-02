/**
 * The browser-dialog fallback for a tool confirmation never cuts the input in
 * silence (apps audit 2026-10-02, low): it shows the start and the end and
 * says how much is left out.
 */
import { describe, expect, it } from 'vitest';
import { confirmInputText } from './app-sandbox';

describe('confirmInputText', () => {
  it('shows a short input whole', () => {
    expect(confirmInputText({ id: 'n1' })).toBe('{\n  "id": "n1"\n}');
  });

  it('shows the start and the end of a long one, and says what is left out', () => {
    const text = confirmInputText({ body: `${'a'.repeat(3000)}TAIL` }, 100);
    expect(text.startsWith('{\n  "body": "aaa')).toBe(true);
    expect(text).toContain('TAIL"\n}');
    expect(text).toMatch(/characters not shown/);
    expect(text).toMatch(/only its start and end are shown/);
  });
});
