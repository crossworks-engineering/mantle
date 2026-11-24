/**
 * The sign-in button label's pattern (sso-label.ts): what the box's setup
 * screen and the Control Center take, and what they refuse.
 */
import { describe, expect, it } from 'vitest';
import { SSO_LABEL_MAX, SSO_LABEL_RE, ssoLabelValue } from './sso-label';

describe('ssoLabelValue', () => {
  it('takes letters of any script, digits, spaces and the plain marks, trimmed', () => {
    for (const ok of [
      'Microsoft',
      'Single sign-on',
      'Okta',
      'Google Workspace',
      "O'Neil & Sons (EU) + Co.",
      'Société Générale',
      'Компания',
      '株式会社',
      'A1',
      '7',
      'x'.repeat(SSO_LABEL_MAX),
    ]) {
      expect(ssoLabelValue(ok), ok).toBe(ok);
      expect(SSO_LABEL_RE.test(ok), ok).toBe(true);
    }
    expect(ssoLabelValue('  Microsoft  ')).toBe('Microsoft');
  });

  it('an empty value clears the label', () => {
    expect(ssoLabelValue('')).toBeNull();
    expect(ssoLabelValue('   ')).toBeNull();
  });

  it('refuses markup, control characters, line breaks, other marks and length', () => {
    for (const bad of [
      '<b>Microsoft</b>',
      'Micro\nsoft',
      'Micro\rsoft',
      'Micro\tsoft',
      'Micro\u0000soft',
      'Micro‮soft',
      'Micro​soft',
      'Okta: sign in',
      'https://evil.example',
      'a"b',
      'a`b',
      'a;b',
      'a/b',
      'a b',
      '...',
      '- -',
      'x'.repeat(SSO_LABEL_MAX + 1),
    ]) {
      expect(ssoLabelValue(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
