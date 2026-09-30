import { describe, expect, it } from 'vitest';
import {
  ClientLinkRetiredError,
  levelForShareMode,
  shareModeForLevel,
  TeamLinkRetiredError,
} from './shares';

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
  });

  it('keeps public under an open link, drops anything higher to public', () => {
    expect(levelForShareMode('public', 'public')).toBe('public');
    expect(levelForShareMode('admin', 'public')).toBe('public');
    expect(levelForShareMode('team', 'public')).toBe('public');
  });

  // Client logins C1 (plan N2): until the old client links are retired they
  // are still live, and no re-sync may move a client item anywhere.
  it('never changes a client item because of a link', () => {
    for (const mode of [null, 'public'] as const) {
      expect(levelForShareMode('client', mode), `${mode}`).toBe('client');
    }
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
