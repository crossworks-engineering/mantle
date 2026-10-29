/**
 * Every answer of the access oracles over every input, as lines, so a change
 * to an oracle shows as a diff of its answers. `oracle-answers.test.ts` pins a
 * hash per oracle, and `pnpm -C packages/db oracle:answers` prints the lines
 * or the inputs whose answer changed (oracle-answers-cli.ts).
 *
 * The inputs are the oracles' own lists, and the kinds are the guide's
 * workspace kinds plus one of each other class, not the registry's: a kind
 * the registry gains changes no hash, a kind the oracle's list gains does.
 */
import { createHash } from 'node:crypto';
import {
  ORACLE_ACTORS,
  ORACLE_ROLES,
  ORACLE_WRITE_ACTIONS,
  ORACLE_WRITE_ROLES,
  expectedFolderCount,
  expectedReadCreate,
  expectedRefusalDetail,
  expectedWrite,
  type FolderCountCaller,
  type FolderCountCase,
  type FolderCountScope,
} from './oracle';
import {
  GUIDE_ACTIONS,
  GUIDE_LOGIN_ACTORS,
  GUIDE_OTHER_ACTORS,
  GUIDE_PLACEMENTS,
  GUIDE_ROLES,
  GUIDE_WORKSPACE_KINDS,
  expectedAccess,
  type GuideSurface,
} from './guide-oracle';

/** The oracles, by name. */
export const ORACLES = ['a1', 'a1-folders', 'a3a', 'a3a-detail', 'a8'] as const;
export type OracleName = (typeof ORACLES)[number];

/** The kinds asked: the guide's workspace kinds, then one of each other
 *  class the oracles tell apart (a conversation kind, a kind of Admin only,
 *  and a name no kind has), each answered not applicable. */
const KINDS: readonly string[] = [
  ...GUIDE_WORKSPACE_KINDS,
  'telegram_message',
  'journal',
  'no_such_kind',
];

/** Every way in (GuideSurface), checked whole by the type. */
const SURFACES = Object.keys({
  sql: 1,
  web: 1,
  'api-v1': 1,
  'mcp-oauth': 1,
  'mcp-key': 1,
  'mcp-stdio': 1,
  peer: 1,
  'web-turn': 1,
  'team-turn': 1,
  telegram: 1,
  heartbeat: 1,
  'admin-heartbeat': 1,
  run: 1,
  recipe: 1,
  pending: 1,
  'app-broker': 1,
  'share-link': 1,
  'contact-share': 1,
} satisfies Record<GuideSurface, 1>) as GuideSurface[];

const line = (input: string, answer: () => unknown): string => {
  let out: string;
  try {
    out = JSON.stringify(answer());
  } catch (err) {
    out = `THROWS ${(err as Error).message}`;
  }
  return `${input}\t${out}`;
};

/** One line per input of oracle `name`: the input, a tab, the answer. */
export function oracleAnswerLines(name: OracleName): string[] {
  const out: string[] = [];
  switch (name) {
    case 'a1':
      for (const placement of ['root', 'folder'] as const)
        for (const role of ORACLE_ROLES)
          for (const kind of KINDS)
            for (const action of ['read', 'create'] as const)
              out.push(
                line(`${placement} ${role} ${kind} ${action}`, () =>
                  expectedReadCreate({ surface: 'sql', placement }, role, kind, action),
                ),
              );
      return out;
    case 'a1-folders':
      for (const c of ['noneShared', 'oneOfThree'] satisfies FolderCountCase[])
        for (const caller of [
          'member',
          'adminUser',
          'adminUserInHome',
        ] satisfies FolderCountCaller[])
          for (const scope of ['all', 'S', 'H'] satisfies FolderCountScope[])
            out.push(line(`${c} ${caller} ${scope}`, () => expectedFolderCount(c, caller, scope)));
      return out;
    case 'a3a':
      for (const placement of ['root', 'folder'] as const)
        for (const actor of ORACLE_ACTORS)
          for (const role of ORACLE_WRITE_ROLES)
            for (const kind of KINDS)
              for (const action of ORACLE_WRITE_ACTIONS)
                out.push(
                  line(`${placement} ${actor} ${role} ${kind} ${action}`, () =>
                    expectedWrite({ surface: 'sql', placement, actor }, role, kind, action),
                  ),
                );
      return out;
    case 'a3a-detail':
      for (const actor of ORACLE_ACTORS)
        for (const role of ORACLE_WRITE_ROLES)
          for (const action of ORACLE_WRITE_ACTIONS)
            out.push(
              line(`${actor} ${role} ${action}`, () => expectedRefusalDetail(actor, role, action)),
            );
      return out;
    case 'a8': {
      const askers = [
        ...GUIDE_LOGIN_ACTORS.flatMap((actor) => GUIDE_ROLES.map((role) => ({ actor, role }))),
        ...GUIDE_OTHER_ACTORS.map((actor) => ({ actor, role: null })),
      ];
      for (const surface of SURFACES)
        for (const placement of GUIDE_PLACEMENTS)
          for (const { actor, role } of askers)
            for (const kind of KINDS)
              for (const action of GUIDE_ACTIONS)
                out.push(
                  line(`${surface} ${placement} ${actor} ${role ?? '-'} ${kind} ${action}`, () =>
                    expectedAccess({ surface, placement, actor }, role, kind, action),
                  ),
                );
      return out;
    }
  }
}

/** The sha256 of oracle `name`'s lines, and how many there are. */
export function oracleAnswerHash(name: OracleName): { inputs: number; sha256: string } {
  const lines = oracleAnswerLines(name);
  return {
    inputs: lines.length,
    sha256: createHash('sha256').update(lines.join('\n')).digest('hex'),
  };
}

/** The inputs whose answer differs between two sets of lines: removed (-),
 *  added (+), or both for a changed answer. */
export function oracleAnswerDiff(before: readonly string[], after: readonly string[]): string[] {
  const map = (lines: readonly string[]) =>
    new Map(lines.filter(Boolean).map((l) => [l.slice(0, l.indexOf('\t')), l] as const));
  const a = map(before);
  const b = map(after);
  const out: string[] = [];
  for (const [input, l] of a) {
    const now = b.get(input);
    if (now === l) continue;
    out.push(`- ${l}`);
    if (now !== undefined) out.push(`+ ${now}`);
  }
  for (const [input, l] of b) if (!a.has(input)) out.push(`+ ${l}`);
  return out;
}
