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
  a3a: {
    inputs: 44_160,
    sha256: '042599d65731af8bacdd3cb86d73ca141963fe73ad0bda80a479aa2b02d9ad57',
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
  a8: {
    inputs: 336_960,
    sha256: 'f84b23b68d7918be15c75e5152c11fcaa1e5962ca2736587759fcb955685a7d0',
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
