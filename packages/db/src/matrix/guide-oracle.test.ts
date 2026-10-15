/**
 * The A8 oracle (./guide-oracle.ts) against the guide's own sentences
 * (docs/workspaces.md; update-prod.md for snapshot copies), so a slip in it
 * shows here before it can make the grid agree with a wrong database.
 */
import { describe, expect, it } from 'vitest';
import {
  GUIDE_ACTIONS,
  GUIDE_ROLES,
  expectedAccess,
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

  it('"It reads only its workspace\'s items": a turn narrows to the assistant\'s workspace', () => {
    // writeGrant's turn is W's: the copy in its private workspace is out.
    expect(expectedAccess(at('snapshot', 'turn'), 'writeGrant', 'page', 'read')).toMatchObject(
      denied,
    );
    expect(expectedAccess(at('root', 'turn'), 'homeModerator', 'note', 'edit')).toEqual(allow);
    // Where the guide is silent the cell is not applicable.
    expect(expectedAccess(at('root', 'turn'), 'homeModerator', 'note', 'grantAdd')).toHaveProperty(
      'na',
    );
  });
});
