/**
 * Tests for the pure near-dup rule helpers. These decide which entities get
 * merged, so a wrong rule = wrongly-fused distinct things (the exact risk that
 * makes auto-merge dangerous). We lock down: org legal-suffix normalisation
 * only strips legal forms (not descriptive words), identifier detection, and
 * the conservative person name-subset rule.
 */
import { describe, expect, it } from 'vitest';
import { isEmailName, isNameSubset, isPhoneName, normaliseOrgName } from './entity-dedup';

describe('normaliseOrgName', () => {
  it('strips trailing legal suffixes', () => {
    expect(normaliseOrgName('Anysphere, Inc.')).toBe('anysphere');
    expect(normaliseOrgName('Pivotal Accounting (Pty) Ltd')).toBe('pivotal accounting');
    expect(normaliseOrgName('ACMTrack CC')).toBe('acmtrack');
    expect(normaliseOrgName('1API GmbH')).toBe('1api');
  });
  it('collapses legal-suffix variants of the same org', () => {
    expect(normaliseOrgName('Cross-Works Engineering')).toBe(normaliseOrgName('Cross-Works Engineering (Pty) Ltd'));
  });
  it('does NOT strip descriptive words (those are review-tier, not auto)', () => {
    // "Pivotal Accounting" vs "Pivotal Accounting Solutions" must NOT auto-collapse —
    // "Solutions" is descriptive, not a legal suffix.
    expect(normaliseOrgName('Pivotal Accounting Solutions')).not.toBe(normaliseOrgName('Pivotal Accounting'));
    expect(normaliseOrgName('ACM Group')).toBe('acm group');
  });
});

describe('isEmailName / isPhoneName', () => {
  it('detects emails', () => {
    expect(isEmailName('jason.schoeman@gmail.com')).toBe(true);
    expect(isEmailName('Jason Schoeman')).toBe(false);
  });
  it('detects bare phone numbers (≥7 digits)', () => {
    expect(isPhoneName('27742329016')).toBe(true);
    expect(isPhoneName('+27 12 673 3000')).toBe(true);
    expect(isPhoneName('Room 101')).toBe(false);
    expect(isPhoneName('12345')).toBe(false); // too few digits
  });
});

describe('isNameSubset (person review tier)', () => {
  it('accepts a strict token-subset with a shared token', () => {
    expect(isNameSubset('Jason', 'Jason Schoeman')).toBe(true);
    expect(isNameSubset('Sarah', 'Sarah Jane Smith')).toBe(true);
  });
  it('rejects different given names sharing a surname', () => {
    expect(isNameSubset('Don Schoeman', 'Jason Schoeman')).toBe(false);
    expect(isNameSubset('Jason', 'Don Schoeman')).toBe(false);
  });
  it('rejects surname-only collisions (the dangerous "C. Schoeman → Jason" case)', () => {
    expect(isNameSubset('C. Schoeman', 'Jason Schoeman')).toBe(false);
    expect(isNameSubset('Sacks', 'David Sacks')).toBe(false); // surname-only — too ambiguous to suggest
  });
  it('rejects a middle-name-only match ("Ann" → "Ashley Ann Schoeman")', () => {
    expect(isNameSubset('Ann', 'Ashley Ann Schoeman')).toBe(false);
  });
  it('rejects equal or longer names (not a strict subset)', () => {
    expect(isNameSubset('Jason Schoeman', 'Jason Schoeman')).toBe(false);
    expect(isNameSubset('Jason Schoeman', 'Jason')).toBe(false);
  });
});
