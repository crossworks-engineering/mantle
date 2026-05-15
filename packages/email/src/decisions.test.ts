import { describe, expect, it } from 'vitest';
import { SenderResolver, type Decision } from './decisions';

/**
 * Pure-logic tests for SenderResolver.decide(). We sidestep the DB by
 * constructing the resolver with pre-populated indexes via the
 * test-friendly constructor.
 */
function make(opts: {
  policy: 'approve_list' | 'block_list';
  addresses?: Record<string, Decision>;
  domains?: Record<string, 'approved' | 'denied'>;
}) {
  return new SenderResolver(
    'user-1',
    opts.policy,
    new Map(Object.entries(opts.addresses ?? {})),
    new Map(Object.entries(opts.domains ?? {})),
  );
}

describe('SenderResolver.decide', () => {
  describe('address-level decisions win', () => {
    it('approved address beats denied domain', () => {
      const r = make({
        policy: 'approve_list',
        addresses: { 'friend@noisy.com': 'approved' },
        domains: { 'noisy.com': 'denied' },
      });
      expect(r.decide('friend@noisy.com')).toBe('approved');
    });

    it('denied address beats approved domain', () => {
      const r = make({
        policy: 'approve_list',
        addresses: { 'spam@trusted.com': 'denied' },
        domains: { 'trusted.com': 'approved' },
      });
      expect(r.decide('spam@trusted.com')).toBe('denied');
    });

    it('pending address falls through to domain', () => {
      const r = make({
        policy: 'approve_list',
        addresses: { 'someone@trusted.com': 'pending' },
        domains: { 'trusted.com': 'approved' },
      });
      expect(r.decide('someone@trusted.com')).toBe('approved');
    });
  });

  describe('domain-level decisions when no address rule applies', () => {
    it('approves anyone in an approved domain', () => {
      const r = make({ policy: 'approve_list', domains: { 'good.com': 'approved' } });
      expect(r.decide('new@good.com')).toBe('approved');
    });

    it('denies anyone in a denied domain', () => {
      const r = make({ policy: 'approve_list', domains: { 'bad.com': 'denied' } });
      expect(r.decide('new@bad.com')).toBe('denied');
    });
  });

  describe('policy defaults when no rule applies', () => {
    it('approve_list defaults to pending', () => {
      const r = make({ policy: 'approve_list' });
      expect(r.decide('unknown@unknown.com')).toBe('pending');
    });

    it('block_list defaults to approved', () => {
      const r = make({ policy: 'block_list' });
      expect(r.decide('unknown@unknown.com')).toBe('approved');
    });
  });

  describe('case insensitivity', () => {
    it('matches addresses case-insensitively', () => {
      const r = make({
        policy: 'approve_list',
        addresses: { 'jason@schoeman.me': 'approved' },
      });
      expect(r.decide('JASON@Schoeman.ME')).toBe('approved');
    });

    it('matches domains case-insensitively', () => {
      const r = make({
        policy: 'approve_list',
        domains: { 'schoeman.me': 'approved' },
      });
      expect(r.decide('someone@SCHOEMAN.ME')).toBe('approved');
    });
  });

  describe('noteSeen', () => {
    it('adds a previously-unknown address as pending', () => {
      const r = make({ policy: 'approve_list' });
      expect(r.has('new@example.com')).toBe(false);
      r.noteSeen('new@example.com');
      expect(r.has('new@example.com')).toBe(true);
      // Still pending — the upsertSenders path is what actually persists.
      expect(r.decide('new@example.com')).toBe('pending');
    });

    it('does not overwrite an existing decision', () => {
      const r = make({
        policy: 'approve_list',
        addresses: { 'friend@example.com': 'approved' },
      });
      r.noteSeen('friend@example.com');
      expect(r.decide('friend@example.com')).toBe('approved');
    });
  });
});
