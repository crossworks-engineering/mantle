/**
 * Per-login assistant resolution (migration 0143) — `resolveAgentForActor`.
 *
 * This is the whole behavioural contract of the feature, and it is three
 * branches deep, so pin the ORDER and the query COUNT:
 *
 *   1. an explicit slug wins outright — the picker is the user's own choice,
 *      and an assignment must never override a deliberate switch;
 *   2. otherwise the login's own assistant;
 *   3. otherwise the brain-wide default, i.e. exactly what every login got
 *      before this feature existed.
 *
 * Query count matters because (2) is on the path of every turn and every thread
 * load: the assignment lookup returns the row, so it must NOT be followed by a
 * re-fetch of the same agent by slug.
 *
 * BOTH collaborators are spies, so every assertion is about arguments and call
 * order rather than about how many rows some shared queue happened to hold. A
 * positional db-result queue cannot tell the two lookups apart: it passes just
 * as happily with the branches reordered, and — worse — with the assignment
 * scoped to the wrong id, which is the single mistake this feature turns on.
 * Both of those are mutation-tested below by assertion, not by row counting.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** What the mocked assignment lookup finds for this login. */
  assigned: null as unknown,
  /** What the mocked brain-wide resolver answers. */
  runtimeResult: null as unknown,
}));

const getAssignedAgent = vi.fn(async () => h.assigned);
const runtimeResolve = vi.fn(async () => h.runtimeResult);

vi.mock('./agents', async () => {
  const actual = await vi.importActual<typeof import('./agents')>('./agents');
  return { ...actual, getAssignedAgent };
});

vi.mock('@mantle/assistant-runtime', async () => {
  const actual = await vi.importActual<typeof import('@mantle/assistant-runtime')>(
    '@mantle/assistant-runtime',
  );
  return { ...actual, resolveAssistantAgent: runtimeResolve };
});

const { resolveAgentForActor } = await import('./assistant');

/** Anchor owner + the login typing. Their ids differ for every co-admin — the
 *  case this feature exists for. */
const user = {
  id: 'anchor-id',
  email: 'sam@example.com',
  actor: { id: 'sam-login-id', email: 'sam@example.com', displayName: null, isOwner: false },
};

const agent = (slug: string) => ({ id: `${slug}-id`, slug, role: 'responder', enabled: true });

beforeEach(() => {
  h.assigned = null;
  h.runtimeResult = null;
  getAssignedAgent.mockClear();
  runtimeResolve.mockClear();
});

describe('resolveAgentForActor', () => {
  it('honours an explicit slug and never looks at the assignment', async () => {
    // An assignment EXISTS — the point is that it loses to a deliberate pick.
    h.assigned = agent('nova');
    h.runtimeResult = agent('remy');

    const picked = await resolveAgentForActor(user, 'remy');

    expect(picked?.slug).toBe('remy');
    expect(runtimeResolve).toHaveBeenCalledWith('anchor-id', 'remy');
    expect(getAssignedAgent).not.toHaveBeenCalled();
  });

  it('uses the login’s own assistant when no slug is given', async () => {
    h.assigned = agent('nova');
    h.runtimeResult = agent('saskia');

    const picked = await resolveAgentForActor(user);

    expect(picked?.slug).toBe('nova');
    // Returned straight from the lookup — never re-fetched by slug afterwards.
    expect(runtimeResolve).not.toHaveBeenCalled();
  });

  it('looks the assignment up by the ACTOR, scoped to the anchor', async () => {
    h.assigned = agent('nova');

    await resolveAgentForActor(user);

    // The mistake this whole feature turns on: every login shares `user.id`
    // (the anchor), so scoping the lookup to it hands them all the SAME
    // assistant and nothing changes. The login is `user.actor.id`.
    expect(getAssignedAgent).toHaveBeenCalledWith('anchor-id', 'sam-login-id');
  });

  it('falls through to the brain default when the login has no assistant', async () => {
    h.assigned = null;
    h.runtimeResult = agent('saskia');

    const picked = await resolveAgentForActor(user);

    expect(picked?.slug).toBe('saskia');
    expect(runtimeResolve).toHaveBeenCalledWith('anchor-id', undefined);
  });

  it('falls back to the brain default when an explicit slug does not resolve', async () => {
    h.runtimeResult = null;
    expect(await resolveAgentForActor(user, 'deleted-agent')).toBeNull();
    // The runtime resolver owns that fallback internally (slug → default), so
    // this asserts we delegate rather than re-implement it.
    expect(runtimeResolve).toHaveBeenCalledWith('anchor-id', 'deleted-agent');
  });
});
