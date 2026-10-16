/**
 * The A8 oracle (./guide-oracle.ts) against the guide's own sentences
 * (docs/workspaces.md; update-prod.md for snapshot copies), so a slip in it
 * shows here before it can make the grid agree with a wrong database.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTACT_WRITES_APP_DATA_ONLY,
  GUIDE_ACTIONS,
  GUIDE_ROLES,
  GUIDE_SILENT_PINNED,
  KEY_SHARED_CONTENT,
  expectedAccess,
  othersRead,
  type GuideActor,
  type GuidePlacement,
} from './guide-oracle';

const at = (placement: GuidePlacement, actor: GuideActor = 'login') => ({
  surface: 'sql' as const,
  placement,
  actor,
});
const allow = { allow: true };
const denied = { allow: false };

describe('the A8 oracle', () => {
  it('13 actions, 6 logins', () => {
    expect(GUIDE_ACTIONS).toHaveLength(13);
    expect(GUIDE_ROLES).toHaveLength(6);
  });

  it('"Read the item: to be a user of a workspace it is granted to"; memory follows the item', () => {
    for (const action of ['read', 'list', 'search'] as const) {
      expect(expectedAccess(at('root'), 'readGrant', 'page', action)).toEqual(allow);
      expect(expectedAccess(at('folder'), 'writeGrant', 'note', action)).toEqual(allow);
      expect(expectedAccess(at('root'), 'outsider', 'page', action)).toMatchObject(denied);
      // "Being an Admin user is management, not reading".
      expect(expectedAccess(at('root'), 'owner', 'page', action)).toMatchObject(denied);
    }
  });

  it('"Edit its content: Moderator of its home, or a grant with Write on"', () => {
    expect(expectedAccess(at('root'), 'homeModerator', 'note', 'edit')).toEqual(allow);
    expect(expectedAccess(at('folder'), 'writeGrant', 'task', 'edit')).toEqual(allow);
    // A Moderator of a workspace that is not the home, with Write off.
    expect(expectedAccess(at('root'), 'readGrant', 'note', 'edit')).toMatchObject(denied);
  });

  it('"Code. A Moderator of the app\'s home builds and edits it."', () => {
    expect(expectedAccess(at('root'), 'homeModerator', 'app', 'editDraft')).toEqual(allow);
    expect(expectedAccess(at('root'), 'writeGrant', 'app', 'editDraft')).toMatchObject(denied);
    expect(expectedAccess(at('root'), 'writeGrant', 'page', 'editDraft')).toEqual(allow);
  });

  it('the grants panel: add needs both Moderators, remove either, Write on both', () => {
    expect(expectedAccess(at('root'), 'homeModerator', 'note', 'grantAdd')).toEqual(allow);
    expect(expectedAccess(at('root'), 'writeGrant', 'note', 'grantAdd')).toMatchObject(denied);
    expect(expectedAccess(at('root'), 'readGrant', 'note', 'grantRemove')).toEqual(allow);
    expect(expectedAccess(at('root'), 'readGrant', 'note', 'writeSwitch')).toMatchObject(denied);
    expect(expectedAccess(at('root'), 'homeModerator', 'note', 'move')).toEqual(allow);
  });

  it('"Open, change or close its link: to be able to edit it (an app: Moderator of its home)"', () => {
    expect(expectedAccess(at('root'), 'writeGrant', 'page', 'link')).toEqual(allow);
    expect(expectedAccess(at('root'), 'writeGrant', 'app', 'link')).toMatchObject(denied);
  });

  it('the home rule: a folder you may edit, else private; Admin users land in Admin', () => {
    expect(expectedAccess(at('folder'), 'writeGrant', 'note', 'create')).toEqual({
      allow: true,
      lands: 'H',
    });
    expect(expectedAccess(at('folder'), 'readGrant', 'note', 'create')).toMatchObject(denied);
    expect(expectedAccess(at('root'), 'outsider', 'note', 'create')).toEqual({
      allow: true,
      lands: 'private',
    });
    expect(expectedAccess(at('root'), 'admin', 'note', 'create')).toEqual({
      allow: true,
      lands: 'admin',
    });
    // In a chat the current workspace is the assistant's.
    expect(expectedAccess(at('root', 'turn'), 'readGrant', 'note', 'create')).toEqual({
      allow: true,
      lands: 'R',
    });
  });

  it('a snapshot copy: read only for everyone, its author included; its author may delete it', () => {
    expect(expectedAccess(at('snapshot'), 'writeGrant', 'page', 'read')).toEqual(allow);
    expect(expectedAccess(at('snapshot'), 'writeGrant', 'page', 'edit')).toMatchObject(denied);
    expect(expectedAccess(at('snapshot'), 'writeGrant', 'page', 'delete')).toEqual(allow);
    expect(expectedAccess(at('snapshot', 'system'), null, 'page', 'edit')).toMatchObject(denied);
    expect(expectedAccess(at('snapshot'), 'writeGrant', 'app', 'read')).toHaveProperty('na');
  });

  it('the actor kinds: a read key, an assistant with no user, a link and a peer write nothing', () => {
    expect(expectedAccess(at('root', 'login-ro'), 'homeModerator', 'note', 'edit')).toMatchObject(
      denied,
    );
    expect(expectedAccess(at('root', 'login-ro'), 'homeModerator', 'note', 'read')).toEqual(allow);
    for (const actor of ['assistant', 'link', 'peer', 'contact-ro'] as const) {
      expect(expectedAccess(at('root', actor), null, 'note', 'edit')).toMatchObject(denied);
    }
    // "With no user ... an assistant only reads": W's assistant reads W's.
    expect(expectedAccess(at('root', 'assistant'), null, 'note', 'read')).toEqual(allow);
    expect(expectedAccess(at('root', 'contact-rw'), null, 'app', 'appData')).toEqual(allow);
  });

  it('an app: its home Moderator, Admin users and the owner delete it (owner decision 2026-10-15, plan s34: an archive)', () => {
    expect(expectedAccess(at('root'), 'homeModerator', 'note', 'delete')).toEqual(allow);
    expect(expectedAccess(at('root'), 'homeModerator', 'app', 'delete')).toEqual(allow);
    expect(expectedAccess(at('folder'), 'homeModerator', 'app', 'delete')).toEqual(allow);
    expect(expectedAccess(at('root', 'turn'), 'homeModerator', 'app', 'delete')).toEqual(allow);
    for (const role of ['writeGrant', 'readGrant'] as const) {
      expect(expectedAccess(at('root'), role, 'app', 'delete')).toEqual({
        allow: false,
        why: 'not a Moderator of its home',
      });
    }
    expect(expectedAccess(at('root'), 'outsider', 'app', 'delete')).toMatchObject(denied);
  });

  it('"It reads only its workspace\'s items": a turn narrows to the assistant\'s workspace', () => {
    // writeGrant's turn is W's: the copy in its private workspace is out.
    expect(expectedAccess(at('snapshot', 'turn'), 'writeGrant', 'page', 'read')).toMatchObject(
      denied,
    );
    expect(expectedAccess(at('root', 'turn'), 'homeModerator', 'note', 'edit')).toEqual(allow);
    // Where the guide is silent the cell is pinned to the narrower answer
    // (by hand allowed, in the turn's scope refused): a deny, named.
    expect(expectedAccess(at('root', 'login'), 'homeModerator', 'note', 'grantAdd')).toEqual(allow);
    expect(expectedAccess(at('root', 'turn'), 'homeModerator', 'note', 'grantAdd')).toEqual({
      allow: false,
      why: GUIDE_SILENT_PINNED,
    });
  });

  it('an item homed in Admin: its users read and change it, nobody else reads it', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(expectedAccess(at('admin'), role, 'note', 'read')).toEqual(allow);
      expect(expectedAccess(at('admin'), role, 'page', 'edit')).toEqual(allow);
      expect(expectedAccess(at('admin', 'turn'), role, 'note', 'edit')).toEqual(allow);
      // "Move it ... Moderator of H and Moderator of T": no Admin user moderates T.
      expect(expectedAccess(at('admin'), role, 'note', 'move')).toMatchObject(denied);
    }
    for (const role of ['homeModerator', 'writeGrant', 'readGrant', 'outsider'] as const) {
      expect(expectedAccess(at('admin'), role, 'note', 'read')).toMatchObject(denied);
      expect(expectedAccess(at('admin'), role, 'note', 'edit')).toMatchObject(denied);
    }
    expect(expectedAccess(at('admin', 'login-ro'), 'owner', 'note', 'edit')).toMatchObject(denied);
    expect(expectedAccess(at('admin', 'assistant'), null, 'note', 'read')).toMatchObject(denied);
    // Admin users delete an app (owner decision 2026-10-15, plan s34).
    expect(expectedAccess(at('admin'), 'owner', 'app', 'delete')).toEqual(allow);
    expect(expectedAccess(at('admin'), 'admin', 'app', 'delete')).toEqual(allow);
    expect(expectedAccess(at('admin', 'turn'), 'admin', 'app', 'delete')).toEqual(allow);
    expect(expectedAccess(at('admin'), 'owner', 'note', 'grantRemove')).toHaveProperty('na');
  });

  it('"A key may not change the content of a page or a note others read"; a peer acting as its login neither', () => {
    const via = (surface: 'peer' | 'api-v1' | 'web', placement: GuidePlacement) => ({
      surface,
      placement,
      actor: 'login' as const,
    });
    const held = { allow: false, why: KEY_SHARED_CONTENT };
    for (const surface of ['peer', 'api-v1'] as const) {
      // Granted beyond Admin (H, W, R), or with an open link (the Admin-homed item).
      expect(expectedAccess(via(surface, 'root'), 'writeGrant', 'note', 'edit')).toEqual(held);
      expect(expectedAccess(via(surface, 'folder'), 'homeModerator', 'page', 'editDraft')).toEqual(
        held,
      );
      expect(expectedAccess(via(surface, 'admin'), 'owner', 'note', 'edit')).toEqual(held);
      // Only a page's or a note's content: a table, a link, a delete as the login.
      expect(expectedAccess(via(surface, 'root'), 'writeGrant', 'table', 'edit')).toEqual(allow);
      expect(expectedAccess(via(surface, 'root'), 'writeGrant', 'page', 'link')).toEqual(allow);
      expect(expectedAccess(via(surface, 'root'), 'homeModerator', 'note', 'delete')).toEqual(
        allow,
      );
    }
    // The login itself, in the app, changes it.
    expect(expectedAccess(via('web', 'root'), 'writeGrant', 'note', 'edit')).toEqual(allow);
    expect(expectedAccess(via('web', 'admin'), 'owner', 'note', 'edit')).toEqual(allow);
    // Others read every placement but a snapshot copy: no open link, and its
    // one grant is its author's private workspace (audit L2).
    expect(othersRead('root')).toBe(true);
    expect(othersRead('folder')).toBe(true);
    expect(othersRead('admin')).toBe(true);
    expect(othersRead('snapshot')).toBe(false);
  });

  it("a contact share with Can write writes its app's data, and nothing else", () => {
    expect(expectedAccess(at('root', 'contact-rw'), null, 'app', 'appData')).toEqual(allow);
    for (const action of ['edit', 'delete', 'move', 'grantAdd', 'link', 'create'] as const) {
      expect(expectedAccess(at('root', 'contact-rw'), null, 'note', action)).toEqual({
        allow: false,
        why: CONTACT_WRITES_APP_DATA_ONLY,
      });
    }
  });
});
