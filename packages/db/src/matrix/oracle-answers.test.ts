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
  a1: { inputs: 360, sha256: 'ed3e8588ce99cad2e14175e9374362ca922c1549940632b45ad9f602304a2d78' },
  'a1-folders': {
    inputs: 18,
    sha256: 'b7cb517807e2bbd8f7fca9c4955ca46fbafc30ad8a1646c6507ec983c4b05461',
  },
  // A canvas's link is its home Moderators', as an app's (owner decision
  // 2026-11-02): 16 inputs moved, each allow to deny, a canvas's openLink,
  // closeLink or deleteLink by a writeGrant or adminWriteGrant login. No
  // other answer moved (checked with --against).
  a3a: {
    inputs: 44_160,
    sha256: '637fa64438df2a921c976d5039c5cbd466cc7661b58b4557a3c41104fa18f074',
  },
  'a3a-detail': {
    inputs: 1_472,
    sha256: 'ee4fd0febe04698dcb17b4fdcefccfb356382de6d1d8d51725ebc4c7235fa764',
  },
  // F6 (the guide names the rule now): 54 inputs moved, each allow to deny
  // "a key or a peer may not change a page or a note others read": the
  // api-v1, mcp-key and peer ways in, actor login, a note's or a page's edit
  // and a page's draft edit, at root and in the folder (homeModerator,
  // writeGrant) and homed in Admin (owner, admin). No other answer moved.
  // The canvas link rule above: 288 inputs moved, all a canvas's link
  // action (an allow to a deny for a non-Moderator editor, and a deny's
  // words to "a canvas's link: Moderator of its home"). No other answer moved.
  a8: {
    inputs: 336_960,
    sha256: 'a0670d12023108b342c773cae744b695e6de3fe642eef30aa7ed10359661fc25',
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
