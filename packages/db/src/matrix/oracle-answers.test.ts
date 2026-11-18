/**
 * Every answer of each access oracle, pinned by a hash (oracle-answers.ts),
 * so an oracle that answers differently anywhere fails here, not only where
 * a guide sentence test or a grid cell happens to look. A change on purpose:
 * see which inputs moved, then take the new hash.
 *
 *   git stash push -- packages/db/src/matrix   # or check out the base
 *   pnpm -C packages/db -s oracle:answers a8 > /tmp/a8-before.txt
 *   git stash pop
 *   pnpm -C packages/db -s oracle:answers a8 --against /tmp/a8-before.txt
 *   pnpm -C packages/db -s oracle:answers      # the new hashes
 */
import { describe, expect, it } from 'vitest';
import { ORACLES, oracleAnswerDiff, oracleAnswerHash } from './oracle-answers';

const PINNED: Readonly<Record<(typeof ORACLES)[number], { inputs: number; sha256: string }>> = {
  // Present (a new workspace kind): its inputs added, every earlier answer
  // unchanged (checked with --against before taking the hashes).
  // Shared items (0382, owner's rule 2026-11-18): 60 inputs moved, all a
  // create in the folder: readGrant (a Moderator of R, which holds it, Write
  // off) deny to allow, writeGrant (a user of W, Write on) allow to deny,
  // and the deny's words of the others ("may not add to the folder"). No
  // other answer moved (checked with --against).
  a1: { inputs: 360, sha256: '2e6abb054430f3fe83f56647e76264983bd16af74ce98a7b5829a736fd9a987d' },
  'a1-folders': {
    inputs: 18,
    sha256: 'b7cb517807e2bbd8f7fca9c4955ca46fbafc30ad8a1646c6507ec983c4b05461',
  },
  // A canvas's link is its home Moderators', as an app's (owner decision
  // 2026-11-02): 16 inputs moved, each allow to deny, a canvas's openLink,
  // closeLink or deleteLink by a writeGrant or adminWriteGrant login. No
  // other answer moved (checked with --against).
  // Contact shares gone (0378): the contact-ro and contact-rw actors and
  // the contact-share surface went, with their inputs; every other answer
  // the same (checked with --against on the base's lines without them).
  // Shared items (0382, owner page d7313c67): 153 inputs moved allow or
  // deny. readGrant (a Moderator of R, Write off) deny to allow on every
  // edit-rule write of a kind that is not an app (edit, rank, a link but a
  // canvas's, a Recall card, a history row), an app's rank in the folder
  // (the folder's order), and a create in the folder;
  // writeGrant and adminWriteGrant (users of W, Write on) allow to deny on a
  // create in the folder; the deny's words of others' folder creates. An
  // app's acts stay as they were. No other answer moved (--against).
  // An Admin user manages every item it reads (owner's word, 2026-11-18,
  // page d7313c67): 70 inputs moved, each deny to allow, all by
  // adminWriteGrant or adminReadGrant (Admin users who read the item through
  // W or R, no Moderator of H): both delete it and open an app's or a
  // canvas's link; adminWriteGrant, who edits it too, also deletes its
  // content row or an app's data row and writes an app's code (those ask
  // edit as well). No other answer moved (checked with --against).
  a3a: {
    inputs: 33_120,
    sha256: '1d50ae49f14f8da2eec249cc3c3351cd45909f434cedc37d8bf0067b09090b91',
  },
  'a3a-detail': {
    inputs: 1_104,
    sha256: 'c071744094f49e02381d612ea5ee0de5549c70845fe5a87147504067684ea912',
  },
  // F6 (the guide names the rule now): 54 inputs moved, each allow to deny
  // "a key or a peer may not change a page or a note others read": the
  // api-v1, mcp-key and peer ways in, actor login, a note's or a page's edit
  // and a page's draft edit, at root and in the folder (homeModerator,
  // writeGrant) and homed in Admin (owner, admin). No other answer moved.
  // The canvas link rule above: 288 inputs moved, all a canvas's link
  // action (an allow to a deny for a non-Moderator editor, and a deny's
  // words to "a canvas's link: Moderator of its home"). No other answer moved.
  // A history entry's delete (historyEntryDelete): one action more, 25,920
  // inputs added (one action's share of the grid). No earlier action's case
  // changed. Its name moved from historyDelete, which is the write grid's
  // (oracle.ts): every answer the same with the old name put back.
  // Only an app and a table have that history, and a snapshot copy has none:
  // 15,120 inputs moved, all that action's, each to not applicable. No earlier
  // action's answer moved (checked with --against).
  // Contact shares gone (0378): 48,720 inputs went with the two contact
  // actors and the contact-share surface; no other answer moved.
  // Shared items (0382, owner page d7313c67): 2,430 inputs moved allow or
  // deny, on every way in. readGrant (a Moderator of R, which holds the
  // item, Write off) deny to allow on edit, editDraft and link of a kind
  // that is not an app (a canvas's link stays its home's), and a create in
  // the folder (a key's or a peer's edit of a page or a note others read
  // stays denied, its words now the key rule's); writeGrant (a user of W,
  // Write on) allow to deny on a create in the folder; other roles' create
  // denials have new words. An app's acts stay as they were. No other
  // answer moved (checked with --against).
  a8: {
    inputs: 314_160,
    sha256: '43ca1cbb36bde1684c1a22abb059605367e9c6f33fc0b1ed70cea9e860ddde6b',
  },
};

describe('the access oracles’ answers', () => {
  for (const name of ORACLES) {
    it(`${name}: every answer as pinned (pnpm -C packages/db oracle:answers ${name})`, () => {
      expect(oracleAnswerHash(name)).toEqual(PINNED[name]);
    });
  }

  it('the diff names each input whose answer changed', () => {
    expect(oracleAnswerDiff(['a\t1', 'b\t2', 'c\t3'], ['a\t1', 'b\t9', 'd\t4'])).toEqual([
      '- b\t2',
      '+ b\t9',
      '- c\t3',
      '+ d\t4',
    ]);
  });
});
