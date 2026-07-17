import { describe, expect, it } from 'vitest';
import {
  canPostToTopic,
  canViewTopic,
  type ForumAuthor,
  type ForumViewer,
  type TopicVisibilityFacts,
} from './forum-visibility';

/**
 * The forum's security boundary. These predicates are the single source of
 * truth for who may read/post a topic; `forum.ts` derives its SQL filter and
 * imperative guards from them, and the turn-pipeline rework must not change
 * them. This is the first product surface where a query bug leaks one member's
 * content to another, so the matrix is enumerated exhaustively.
 */

const OWNER: ForumViewer = { kind: 'owner' };
const ALICE: ForumViewer = { kind: 'member', contactId: 'alice' };
const BOB: ForumViewer = { kind: 'member', contactId: 'bob' };

const teamTopic: TopicVisibilityFacts = { visibility: 'team', createdByContactId: 'alice' };
const alicePrivate: TopicVisibilityFacts = { visibility: 'private', createdByContactId: 'alice' };
const ownerPrivate: TopicVisibilityFacts = { visibility: 'private', createdByContactId: null };
const teamOwnerAuthored: TopicVisibilityFacts = { visibility: 'team', createdByContactId: null };

describe('canViewTopic', () => {
  it('owner sees every topic regardless of visibility or author', () => {
    for (const t of [teamTopic, alicePrivate, ownerPrivate, teamOwnerAuthored]) {
      expect(canViewTopic(OWNER, t)).toBe(true);
    }
  });

  it('any member sees any team topic', () => {
    expect(canViewTopic(ALICE, teamTopic)).toBe(true);
    expect(canViewTopic(BOB, teamTopic)).toBe(true);
    expect(canViewTopic(BOB, teamOwnerAuthored)).toBe(true);
  });

  it('a member sees their OWN private topic', () => {
    expect(canViewTopic(ALICE, alicePrivate)).toBe(true);
  });

  it("a member CANNOT see another member's private topic", () => {
    expect(canViewTopic(BOB, alicePrivate)).toBe(false);
  });

  it('no member sees an owner-authored private topic (createdByContactId null)', () => {
    expect(canViewTopic(ALICE, ownerPrivate)).toBe(false);
    expect(canViewTopic(BOB, ownerPrivate)).toBe(false);
  });

  it('a null author on a private topic never matches a member (no null===null leak)', () => {
    // Guards against `createdByContactId === viewer.contactId` where a stray
    // null/undefined contactId could equal a null author.
    const nullish = { kind: 'member', contactId: null as unknown as string };
    expect(canViewTopic(nullish as ForumViewer, ownerPrivate)).toBe(false);
  });
});

describe('canPostToTopic', () => {
  const memberAlice: ForumAuthor = { kind: 'member', contactId: 'alice' };
  const memberBob: ForumAuthor = { kind: 'member', contactId: 'bob' };
  const owner: ForumAuthor = { kind: 'owner', name: 'Jason' };
  const agent: ForumAuthor = { kind: 'agent', agentId: 'a1', name: 'Team Responder' };

  it('owner and agent may post into ANY topic (incl. private, incl. others private)', () => {
    for (const t of [teamTopic, alicePrivate, ownerPrivate]) {
      expect(canPostToTopic(owner, t)).toBe(true);
      expect(canPostToTopic(agent, t)).toBe(true);
    }
  });

  it('a member may post into team topics and their own private topic', () => {
    expect(canPostToTopic(memberAlice, teamTopic)).toBe(true);
    expect(canPostToTopic(memberAlice, alicePrivate)).toBe(true);
  });

  it("a member CANNOT post into another member's private topic", () => {
    expect(canPostToTopic(memberBob, alicePrivate)).toBe(false);
  });

  it('a member cannot post into an owner-authored private topic', () => {
    expect(canPostToTopic(memberBob, ownerPrivate)).toBe(false);
  });

  it('post-visibility exactly mirrors read-visibility for members', () => {
    for (const t of [teamTopic, alicePrivate, ownerPrivate, teamOwnerAuthored]) {
      expect(canPostToTopic(memberBob, t)).toBe(canViewTopic(BOB, t));
    }
  });
});
