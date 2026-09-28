import { describe, expect, it } from 'vitest';
import {
  ClientLinkRetiredError,
  levelForShareMode,
  shareCascadeOf,
  shareModeForLevel,
  TeamLinkRetiredError,
} from './shares';

describe('shareCascadeOf', () => {
  it('defaults to false when unset (pre-existing shares never cascade)', () => {
    expect(shareCascadeOf({ settings: {} })).toBe(false);
    expect(shareCascadeOf({ settings: null as unknown as Record<string, unknown> })).toBe(false);
    expect(shareCascadeOf({ settings: { mode: 'team' } })).toBe(false);
  });

  it('reads cascade only from a strict boolean true', () => {
    expect(shareCascadeOf({ settings: { cascade: true } })).toBe(true);
    expect(shareCascadeOf({ settings: { mode: 'team', cascade: true } })).toBe(true);
    expect(shareCascadeOf({ settings: { cascade: false } })).toBe(false);
    expect(shareCascadeOf({ settings: { cascade: 'yes' } })).toBe(false);
  });
});

describe('levels drive links', () => {
  // Team links are retired (member logins Phase 6 stage 6): team is a level
  // members read by, with no link.
  it('maps each level to the link it needs: an open one at public only', () => {
    expect(shareModeForLevel('admin')).toBeNull();
    expect(shareModeForLevel('team')).toBeNull();
    // Client logins C1: client means signed-in clients, never a link.
    expect(shareModeForLevel('client')).toBeNull();
    expect(shareModeForLevel('public')).toBe('public');
  });

  it('derives admin from no link, except that a team item stays at team', () => {
    expect(levelForShareMode('public', null)).toBe('admin');
    expect(levelForShareMode('admin', null)).toBe('admin');
    expect(levelForShareMode('team', null)).toBe('team');
    expect(levelForShareMode('team', null, 'team')).toBe('team');
    // A cascaded sub-page whose parent went to admin goes with it.
    expect(levelForShareMode('team', null, 'admin')).toBe('admin');
  });

  it("takes a cascaded sub-page to team when its parent's link goes because the parent went to team", () => {
    expect(levelForShareMode('public', null, 'team')).toBe('team');
    // Never lowers an admin sub-page on its own.
    expect(levelForShareMode('admin', null, 'team')).toBe('admin');
  });

  it('keeps public under an open link, drops anything higher to public', () => {
    expect(levelForShareMode('public', 'public')).toBe('public');
    expect(levelForShareMode('admin', 'public')).toBe('public');
    expect(levelForShareMode('team', 'public')).toBe('public');
  });

  // Client logins C1 (plan N2): until the old client links are retired they
  // are still live, and no re-sync may move a client item anywhere.
  it('never changes a client item because of a link, whatever the parent', () => {
    for (const mode of [null, 'public'] as const) {
      for (const preferred of [undefined, 'admin', 'team', 'client', 'public'] as const) {
        expect(levelForShareMode('client', mode, preferred), `${mode} ${preferred}`).toBe('client');
      }
    }
  });

  it('never makes a sub-page client through a client parent', () => {
    expect(levelForShareMode('public', 'public', 'client')).toBe('public');
    expect(levelForShareMode('admin', 'public', 'client')).toBe('public');
    expect(levelForShareMode('admin', null, 'client')).toBe('admin');
  });

  it('round-trips every level through its link', () => {
    for (const level of ['admin', 'team', 'client', 'public'] as const) {
      expect(levelForShareMode(level, shareModeForLevel(level))).toBe(level);
    }
  });
});

describe('ClientLinkRetiredError', () => {
  it('names the reason and says clients sign in, public is the open link', () => {
    const err = new ClientLinkRetiredError();
    expect(err.reason).toBe('client-links-retired');
    expect(err.message).toMatch(/clients sign in/);
    expect(err.message).toMatch(/public/);
  });
});

describe('TeamLinkRetiredError', () => {
  it('names the reason and says members use their own logins', () => {
    const err = new TeamLinkRetiredError();
    expect(err.reason).toBe('team-links-retired');
    expect(err.message).toMatch(/own logins/);
    expect(err.message).toMatch(/level to team/);
  });
});
