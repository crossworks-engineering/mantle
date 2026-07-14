import { describe, expect, it } from 'vitest';
import { PEER_SHAREABLE_TYPES, isPeerShareableType } from './peers';

/**
 * The category-share allowlist is a SECURITY boundary — a type listed here can
 * be subscribed to wholesale by a peer, future nodes included. These tests pin
 * the boundary so widening it is always a deliberate, reviewed change.
 */
describe('PEER_SHAREABLE_TYPES', () => {
  it('offers exactly the agreed categories', () => {
    expect([...PEER_SHAREABLE_TYPES].sort()).toEqual(
      ['contact', 'event', 'file', 'note', 'page', 'table', 'task'].sort(),
    );
  });

  it('never offers the private or structural types', () => {
    // secrets + peer records: never shareable at all via the category surface.
    // email + journal: the owner's private corpus — deliberately excluded even
    // though individual nodes can still be cherry-picked via peer_shares.
    for (const forbidden of ['secret', 'mantle_peer', 'email', 'journal', 'branch']) {
      expect(isPeerShareableType(forbidden)).toBe(false);
    }
  });

  it('isPeerShareableType matches the list', () => {
    for (const t of PEER_SHAREABLE_TYPES) expect(isPeerShareableType(t)).toBe(true);
    expect(isPeerShareableType('')).toBe(false);
    expect(isPeerShareableType('pages')).toBe(false); // singular types only
  });
});
