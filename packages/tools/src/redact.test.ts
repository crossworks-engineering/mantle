/**
 * Redaction guard for sensitive tool inputs. This is the regression
 * we never want to hit: a tool like `secret_create` whose entire
 * purpose is to seal a value would defeat itself if the plaintext
 * also landed in `trace_steps.input` next to the encrypted row.
 *
 * These tests pin down the contract:
 *   1. `redactInputFields` declared on a builtin → those keys are
 *      replaced with the sentinel string in the args-for-logging
 *      copy, NOT the args the handler receives.
 *   2. The lookup is O(1) per slug — no scan.
 *   3. Unknown slugs return [], not undefined, so callers can iterate
 *      without nil-checking.
 *   4. The redaction is a copy: the original input object is
 *      untouched (so the handler still gets the real value).
 */

import { describe, expect, it } from 'vitest';
import { getBuiltinRedactFields, redactArgsForLogging } from './registry';

describe('getBuiltinRedactFields', () => {
  it('returns the declared sensitive fields for secret_create', () => {
    const fields = getBuiltinRedactFields('secret_create');
    expect(fields).toContain('value');
  });

  it('returns an empty array for non-sensitive builtins', () => {
    expect(getBuiltinRedactFields('search_nodes')).toEqual([]);
    expect(getBuiltinRedactFields('node_read')).toEqual([]);
  });

  it('returns an empty array for unknown slugs (no nil)', () => {
    expect(getBuiltinRedactFields('totally_made_up')).toEqual([]);
  });
});

describe('redactArgsForLogging', () => {
  it('replaces named fields with [REDACTED]', () => {
    const out = redactArgsForLogging({ title: 'Safe PIN', value: '4827', kind: 'password' }, [
      'value',
    ]);
    expect(out.value).toBe('[REDACTED]');
    expect(out.title).toBe('Safe PIN');
    expect(out.kind).toBe('password');
  });

  it('does NOT mutate the input object', () => {
    const input = { title: 'X', value: 'secret' };
    redactArgsForLogging(input, ['value']);
    // The original is intact so the handler still sees the real value.
    expect(input.value).toBe('secret');
  });

  it('redacts every declared field even when there are several', () => {
    const out = redactArgsForLogging(
      { username: 'jason', password: 'hunter2', api_key: 'sk-abc' },
      ['password', 'api_key'],
    );
    expect(out.username).toBe('jason');
    expect(out.password).toBe('[REDACTED]');
    expect(out.api_key).toBe('[REDACTED]');
  });

  it('returns the same object reference when fields is empty', () => {
    const input = { title: 'X' };
    const out = redactArgsForLogging(input, []);
    // Cheap-path: no work needed, no allocation. The contract is
    // "no leak", and an empty fields list is a no-op.
    expect(out).toBe(input);
  });

  it('skips fields that are absent on the input (no key added)', () => {
    const out = redactArgsForLogging({ title: 'X' }, ['value']);
    expect('value' in out).toBe(false);
  });

  it('redacts non-string values too (so a JSON.stringify of the output cannot leak partial data)', () => {
    // Defence in depth: if a future tool declares a sensitive field
    // that happens to come through as a number (PIN sent as integer)
    // or an object (a credential bundle), it still gets masked.
    const out = redactArgsForLogging({ pin: 4827, bundle: { user: 'x', pass: 'y' } }, [
      'pin',
      'bundle',
    ]);
    expect(out.pin).toBe('[REDACTED]');
    expect(out.bundle).toBe('[REDACTED]');
  });

  it('JSON.stringify of redacted output never contains the secret value', () => {
    // The whole point — `trace_steps.input` is a jsonb column, so
    // whatever we hand off must survive JSON.stringify without
    // leaking the plaintext.
    const out = redactArgsForLogging({ title: 'Safe PIN', value: '4827-MUST-NOT-LEAK' }, ['value']);
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain('4827');
    expect(serialised).not.toContain('MUST-NOT-LEAK');
    expect(serialised).toContain('[REDACTED]');
  });
});
