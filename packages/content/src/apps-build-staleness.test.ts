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

/**
 * The other half of the same invariant: a REBUILD must be publishable.
 *
 * `app_build` compiles `draft ?? source`, so an app with no draft builds its
 * PUBLISHED source. When publish gated on the draft source, that build could
 * never ship — which is how every app on a box rolled past v0.230.57 ended up
 * serving no stylesheet, with the repair (a rebuild) blocked by the publish
 * path itself. These assert the shape at the source level, where the mistake is
 * made, since a DB-backed test would need a live Postgres.
 */
describe('publishApp promotes a build-only rebuild', () => {
  const src = readFileSync(new URL('./apps.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export async function publishApp'));

  it('does not bail out on a missing draft alone', () => {
    // The early return must require BOTH: nothing staged AND nothing rebuilt.
    expect(
      /if \(!app\.draft && !app\.draftBuild\) return app;/.test(body),
      'publishApp returns early on `!app.draft` alone — a rebuilt bundle for ' +
        'unchanged source can then never be published, which is the v0.230.57 ' +
        'CSS-sidecar trap',
    ).toBe(true);
  });

  it('writes the source only when a draft is actually staged', () => {
    expect(
      /const sourceFields = published\s*\?\s*\{ source:/.test(body),
      'publishApp writes `source` unconditionally — a build-only publish would ' +
        'then overwrite the published source with undefined/null',
    ).toBe(true);
    const setPayload = body.slice(body.indexOf('.set({'), body.indexOf('.where('));
    expect(/\.\.\.sourceFields,/.test(setPayload)).toBe(true);
  });

  it('always promotes the build it validated', () => {
    const setPayload = body.slice(body.indexOf('.set({'), body.indexOf('.where('));
    expect(/publishedBuild: build,/.test(setPayload)).toBe(true);
  });
});
