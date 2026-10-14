/**
 * The one rule a run marks third-party text by (A5 step 6a fix round 1,
 * LOW-6): a fenced result, and a failure that quotes a remote answer.
 */
import { describe, expect, it } from 'vitest';
import { outcomeIsThirdParty } from './third-party';

describe('outcomeIsThirdParty', () => {
  it('a result the tool loop fences: by policy or by dispatch provenance', () => {
    expect(outcomeIsThirdParty(true, 'builtin', { ok: true, output: 'x' })).toBe(true);
    expect(outcomeIsThirdParty(false, 'http', { ok: true, output: 'x', untrusted: true })).toBe(
      true,
    );
    expect(outcomeIsThirdParty(false, 'http', { ok: true, output: 'x' })).toBe(false);
    expect(outcomeIsThirdParty(false, 'builtin', { ok: true, output: 'x' })).toBe(false);
  });

  it("an http, connector or recipe row's failure, and an untrusted policy's", () => {
    const failed = { ok: false as const, error: '502 Bad Gateway: <remote body>' };
    for (const kind of ['http', 'mcp', 'recipe']) {
      expect(outcomeIsThirdParty(false, kind, failed), kind).toBe(true);
    }
    expect(outcomeIsThirdParty(true, 'builtin', failed)).toBe(true);
    expect(outcomeIsThirdParty(false, 'builtin', failed)).toBe(false);
    expect(outcomeIsThirdParty(false, 'shell', failed)).toBe(false);
    expect(outcomeIsThirdParty(false, undefined, failed)).toBe(false);
  });
});
