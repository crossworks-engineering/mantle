/**
 * The A8 cells that fail today (the database, or a way in, gives another
 * answer than the guide), each a finding for the owner to decide: the cell's
 * name (a8-grid.ts cellName; a surface cell's name starts with its surface),
 * the finding it belongs to, and a piece of the reason it fails with. A
 * listed cell is known only while it fails for that reason: one that fails
 * for another reason fails the run like an unlisted one. The matrix is
 * test code only: a finding is never fixed here. The grid and the surface
 * cells fail on a failure not listed, and on a listed one that passes (the
 * list only shrinks). The suites: docs/actors.md, "Proof".
 */

/* P1 (below on: a tool edit the database refuses only when on) is gone:
 * every cell it listed was the read grant's member, a Moderator of R, and
 * since 0382 a Moderator of a workspace that holds an item edits it, Write
 * on or off (owner page d7313c67), so those cells pass in every mode. */

/** A hidden folder path shows to an Admin user: file_create makes
 *  the missing folders of its path (makesFolders), so a free path is made
 *  and answered ok while the path of a folder the caller does not read
 *  answers "parent folder ... not found" (no row changes, but the folder's
 *  existence shows). The owner accepted it as a known limit; the folder
 *  trail (migration 0311) is for a login's own session and leaves the
 *  tools as they are. */
const S11A_1 = 'S11a-1 a hidden folder path shows (file_create makes a free path)';
const HIDDEN_PATH_SHOWS: readonly string[] = ['web-turn turn', 'mcp-oauth login'].flatMap((w) =>
  ['owner', 'admin'].map((r) => `tool:file_create ${w}/${r} create file @folder`),
);

/** The actor check modes the surface cells run in (docs/update-prod.md):
 *  off, warn and on. The fleet runs on (the actor and the edit check
 *  both); off and warn stay for a box that lowers them. */
export type CheckMode = 'off' | 'warn' | 'on';
export const CHECK_MODES: readonly CheckMode[] = ['off', 'warn', 'on'];

export type KnownFailure = {
  /** The finding (F1, F2, ...). */
  finding: string;
  /** A piece of the cell's failure reason, as the run prints it (or one of
   *  several: a cell that fails in another words in each mode). */
  reason: string | readonly string[];
  /** A surface cell: the modes it fails in (all three when not given). */
  modes?: readonly CheckMode[];
};

const known = (
  finding: string,
  reason: string | readonly string[],
  modes?: readonly CheckMode[],
): KnownFailure => (modes ? { finding, reason, modes } : { finding, reason });

export const KNOWN_FAILURES: Readonly<Record<string, KnownFailure>> = {
  // The tool cells: the findings in both modes.
  ...Object.fromEntries(
    HIDDEN_PATH_SHOWS.map((name) => [name, known(S11A_1, "not a random uuid's answer")]),
  ),
  // The grid (SQL): none.
  // The surface cells: none.
};

/**
 * A run's failures against the list: `grid` the SQL grid's cells (a name
 * whose first word holds a '/'), else the surface cells' in check `mode`,
 * or with `tools` the tool cells' (a name that starts `tool:`).
 * `unexpected`: a failure not listed (for this mode), or listed for another
 * reason (both fail the run); `fixed`: a listed cell that did not fail
 * (take it off the list, or off this mode).
 */
export function sortFailures(
  failures: ReadonlyMap<string, string>,
  grid: boolean,
  mode?: CheckMode,
  tools = false,
): { unexpected: string[]; fixed: string[] } {
  const ours = (name: string) =>
    name.split(' ')[0]!.includes('/') === grid &&
    name.startsWith('tool:') === tools &&
    (grid || !mode || !KNOWN_FAILURES[name]?.modes || KNOWN_FAILURES[name]!.modes!.includes(mode));
  const unexpected: string[] = [];
  for (const [name, why] of failures) {
    const k = KNOWN_FAILURES[name];
    if (!k || !ours(name)) unexpected.push(`${name}: ${why}`);
    else if (!(typeof k.reason === 'string' ? [k.reason] : k.reason).some((r) => why.includes(r))) {
      unexpected.push(
        `${name}: listed (${k.finding}) for "${String(k.reason)}", fails with: ${why}`,
      );
    }
  }
  const fixed = Object.keys(KNOWN_FAILURES).filter((n) => ours(n) && !failures.has(n));
  if (mode) return { unexpected, fixed: fixed.map((n) => `${n} (check ${mode})`) };
  return { unexpected, fixed };
}
