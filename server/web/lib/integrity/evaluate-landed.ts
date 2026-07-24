/**
 * Pure evaluation of a real node's footprint → per-row state + check pills.
 *
 * Kept db-free (separate from `landed.ts`, which imports the DB client) so the
 * honesty rules below can be unit-tested in isolation — same split as
 * `model-select-utils.ts`.
 *
 * Honest by construction: green only when the extractor succeeded AND the
 * searchable layers (summary · 768-dim embedding · tsv) actually landed; a
 * *correct* skip is neutral and surfaces its disposition; red is reserved for
 * genuine bugs (success-but-no-summary, dimension drift, duplicate edges).
 */
import type { CheckResult, LandedState, ProbeFootprint } from '@mantle/web-ui/types/integrity';

/** Every brain vector is `vector(768)` (EmbeddingGemma, migration 0060). A
 *  landed embedding with any other dim is a drift bug. */
export const EXPECTED_DIMS = 768;

/** No terminal extractor_run after this long ⇒ stalled (not just slow). */
export const STALL_MS = 90_000;

export function evaluateLanded(
  fp: ProbeFootprint,
  ageMs: number,
): { state: LandedState; checks: CheckResult[] } {
  if (!fp.run) {
    if (ageMs > STALL_MS) {
      return {
        state: 'stalled',
        checks: [
          {
            label: 'Trace',
            status: 'fail',
            detail:
              'no extractor_run settled — is apps/agent running and an extractor worker configured?',
          },
        ],
      };
    }
    return {
      state: 'indexing',
      checks: [{ label: 'Trace', status: 'info', detail: 'waiting for the extractor…' }],
    };
  }

  const run = fp.run;

  if (run.status === 'error') {
    return {
      state: 'fail',
      checks: [{ label: 'Trace', status: 'fail', detail: 'extractor_run errored' }],
    };
  }

  if (run.status === 'skipped') {
    const checks: CheckResult[] = [
      {
        label: 'Disposition',
        status: 'info',
        detail: `skipped${run.disposition ? `: ${run.disposition}` : ''}`,
      },
    ];
    if (fp.summary)
      checks.push({ label: 'L5 summary', status: 'info', detail: `“${fp.summary.slice(0, 60)}”` });
    return { state: 'skipped', checks };
  }

  // success — assert the searchable layers landed.
  const checks: CheckResult[] = [{ label: 'Disposition', status: 'info', detail: 'success' }];

  checks.push({
    label: 'L5 summary',
    status: fp.summary ? 'pass' : 'fail',
    detail: fp.summary
      ? `“${fp.summary.slice(0, 60)}”`
      : 'empty (success but no summary — silent miss)',
  });

  const hasEmb = fp.embDims != null;
  checks.push({
    label: 'L5 embedding',
    status: hasEmb ? 'pass' : 'fail',
    detail: hasEmb ? `${fp.embDims}-dim` : 'none',
  });
  if (hasEmb && fp.embDims !== EXPECTED_DIMS) {
    checks.push({
      label: `Emb ${EXPECTED_DIMS}`,
      status: 'fail',
      detail: `${fp.embDims} dims · expected ${EXPECTED_DIMS}`,
    });
  }

  checks.push({
    label: 'L5 tsv',
    status: fp.hasTsv ? 'pass' : 'fail',
    detail: fp.hasTsv ? 'set' : 'missing',
  });

  // Facts + graph are content-dependent — informational, never red on absence.
  checks.push({
    label: 'L4 facts',
    status: 'info',
    detail: `${fp.nFacts}${fp.factKinds.length ? ` (${fp.factKinds.join(',')})` : ''}`,
  });
  checks.push({ label: 'Graph', status: 'info', detail: `${fp.nEntities} mentioned_in` });

  if (fp.dupMentionEdges > 0) {
    checks.push({
      label: 'Dup edges',
      status: 'fail',
      detail: `${fp.dupMentionEdges} duplicate mentioned_in (extractor appended instead of rebuilding)`,
    });
  }

  const state: LandedState = checks.some((c) => c.status === 'fail') ? 'fail' : 'ok';
  return { state, checks };
}
