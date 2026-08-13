import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Tripwire for the draft-build invariant.
 *
 * `apps.draft_build` is a build OF `apps.draft_source`. `publishApp` promotes
 * both together, and it gates only on `draft_build.ok` — it cannot tell whether
 * that build actually came from the source it is shipping alongside. So if any
 * writer updates `draft_source` and leaves a green `draft_build` behind, the
 * next publish pairs NEW source with an OLD bundle and the app serves code that
 * is provably absent from its own source.
 *
 * That failure is close to undiagnosable from the outside: source inspection
 * (what an agent does) says the change landed, while every browser on every
 * machine keeps rendering the stale bundle, so it presents as "the edit did
 * nothing" and survives hard refreshes, other browsers, and republishing.
 *
 * A DB-backed test would need a live Postgres; this asserts the property at the
 * source level instead, which is where the mistake is actually made.
 */
describe('draft source writers invalidate the staged build', () => {
  const src = readFileSync(new URL('./apps.ts', import.meta.url), 'utf8');

  // Every `.set({ … })` payload in the file, captured non-greedily.
  const setPayloads = [...src.matchAll(/\.set\(\{([\s\S]*?)\}\)/g)].map((m) => m[1] ?? '');

  it('finds the draft-source writers it means to guard', () => {
    const writers = setPayloads.filter((p) => /\bdraftSource:/.test(p));
    // saveDraftSource, writeDraftFile, deleteDraftFile, discardDraft, publishApp.
    expect(writers.length).toBeGreaterThanOrEqual(5);
  });

  it('never writes draftSource without also writing draftBuild', () => {
    const offenders = setPayloads.filter(
      (p) => /\bdraftSource:/.test(p) && !/\bdraftBuild:/.test(p),
    );
    expect(
      offenders,
      'a .set() that changes draftSource must also set draftBuild (null to invalidate) — ' +
        'otherwise publishApp can ship new source with a stale bundle',
    ).toEqual([]);
  });
});
