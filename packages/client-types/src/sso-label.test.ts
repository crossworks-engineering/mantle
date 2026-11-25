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

  it('takes combining marks after a letter: Hindi, Tamil, Arabic with vowel marks', () => {
    for (const ok of ['हिन्दी', 'माइक्रोसॉफ्ट', 'தமிழ்', 'مَايْكْرُوسُوفْت', 'עִבְרִית']) {
      expect(ssoLabelValue(ok), ok).toBe(ok.normalize('NFC'));
    }
  });

  it('puts an accent typed in two parts into NFC, and stores that', () => {
    const decomposed = 'Socie\u0301te\u0301 Ge\u0301ne\u0301rale';
    expect(decomposed).not.toBe('Société Générale');
    expect(ssoLabelValue(decomposed)).toBe('Société Générale');
    // A mark with no letter of its own to compose with stays a mark, after a letter.
    expect(ssoLabelValue('q\u0301')).toBe('q\u0301');
  });

  it('takes Thai, Vietnamese, Arabic and Hebrew with their marks', () => {
    for (const ok of ['ภาษาไทย', 'ที่นี่', 'มหาวิทยาลัย', 'مُحَمَّد', 'بِسْمِ ٱللَّهِ', 'בְּרֵאשִׁית']) {
      expect(ssoLabelValue(ok), ok).toBe(ok.normalize('NFC'));
    }
    // Vietnamese typed in parts (NFD) is one letter each in NFC.
    expect(ssoLabelValue('Tiếng Việt'.normalize('NFD'))).toBe('Tiếng Việt');
    // Four marks on one letter fit.
    expect(ssoLabelValue('q\u0301\u0302\u0303\u0304')).toBe('q\u0301\u0302\u0303\u0304');
  });

  it('refuses what shows nothing: joiners, selectors, Hangul fillers, a stack of marks', () => {
    for (const bad of [
      'Okta\u034Fx',
      'a\u034F',
      'Okta\uFE0F',
      'Okta\uFE00',
      'Okta\u{E0100}',
      'Okta\u180B',
      'Okta\u180F',
      '\u3164',
      '\u3164\u3164',
      'Okta\u3164',
      'Okta \u115F',
      'Okta\u1160',
      '\uFFA0x',
      // Five marks on one letter, and 59 on one.
      'q\u0301\u0302\u0303\u0304\u0305',
      'q' + '\u0301'.repeat(59),
    ]) {
      expect(ssoLabelValue(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('takes the curly apostrophe', () => {
    expect(ssoLabelValue('O’Neil Corp')).toBe('O’Neil Corp');
  });

  it('counts the length in code points after NFC', () => {
    // 60 accented letters typed in two parts each: 120 code points, 60 after NFC.
    expect(ssoLabelValue('e\u0301'.repeat(SSO_LABEL_MAX))).toBe('é'.repeat(SSO_LABEL_MAX));
    expect(ssoLabelValue('é'.repeat(SSO_LABEL_MAX + 1))).toBe(false);
    // An astral letter is one code point.
    expect(ssoLabelValue('𐐷'.repeat(SSO_LABEL_MAX))).toBe('𐐷'.repeat(SSO_LABEL_MAX));
  });

  it('an empty value clears the label', () => {
    expect(ssoLabelValue('')).toBeNull();
    expect(ssoLabelValue('   ')).toBeNull();
  });

  it('refuses markup, control and format characters, other marks, emoji and length', () => {
    for (const bad of [
      '<b>Microsoft</b>',
      'Micro\nsoft',
      'Micro\rsoft',
      'Micro\tsoft',
      'Micro\u0000soft',
      'Micro\u007fsoft',
      // Right-to-left marks and overrides, isolates.
      'Micro‏soft',
      'Micro‎soft',
      'Micro‮soft',
      'Micro⁧soft',
      // Zero-width characters and the byte order mark.
      'Micro​soft',
      'Micro‌soft',
      'Micro‍soft',
      'Micro﻿soft',
      // A no-break space and other spaces.
      'a b',
      'a b',
      'a　b',
      // Emoji, alone or with a joiner or a selector.
      'Okta 🔐',
      '❤️',
      '👍🏽',
      // A combining mark with no letter before it.
      '\u0301abc',
      'a \u0301b',
      '(\u0301)',
      'Okta: sign in',
      'https://evil.example',
      'a"b',
      'a`b',
      'a;b',
      'a/b',
      'a‘b',
      '...',
      '- -',
      'x'.repeat(SSO_LABEL_MAX + 1),
    ]) {
      expect(ssoLabelValue(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
