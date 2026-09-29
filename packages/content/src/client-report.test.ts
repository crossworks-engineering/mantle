/**
 * The pure parts of "What clients see" (audit A7, A23): the fingerprint the
 * admin acknowledges, and the addresses an email hint takes from a to / cc /
 * bcc string. The report itself is client-report.db.test.ts.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { clientReportFingerprint, emailAddresses } from './client-report';

describe('clientReportFingerprint', () => {
  it('is sha256 hex of the ids sorted and joined by commas, whatever the order', () => {
    const a = '0a000000-0000-4000-8000-000000000000';
    const b = '0b000000-0000-4000-8000-000000000000';
    const want = createHash('sha256').update(`${a},${b}`).digest('hex');
    expect(clientReportFingerprint([b, a])).toBe(want);
    expect(clientReportFingerprint([a, b])).toBe(want);
    expect(clientReportFingerprint([a])).not.toBe(want);
  });
});

describe('emailAddresses', () => {
  it('takes bare and named addresses, lower case, display names left out', () => {
    expect(
      emailAddresses('Ann <Ann@Example.invalid>, bob@example.invalid; "Dee, D." <dee@x.invalid>'),
    ).toEqual(['ann@example.invalid', 'bob@example.invalid', 'dee@x.invalid']);
  });

  it('is empty for nothing', () => {
    expect(emailAddresses(null)).toEqual([]);
    expect(emailAddresses('no address here')).toEqual([]);
  });
});
