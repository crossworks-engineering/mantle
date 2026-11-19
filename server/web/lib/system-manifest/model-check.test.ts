import { describe, expect, it } from 'vitest';
import { MANIFEST_AGENTS, MANIFEST_WORKERS, type ManifestWorker } from './manifest';
import { checkModels, modelCheckReport, type ModelCheckWorkerRow } from './model-check';

/** A box that runs every default exactly. */
function defaultBox() {
  return {
    workers: MANIFEST_WORKERS.map((w): ModelCheckWorkerRow => ({
      kind: w.kind,
      provider: w.provider,
      model: w.model,
      params: w.params,
    })),
    agents: MANIFEST_AGENTS.map((a) => ({
      slug: a.slug,
      enabled: true,
      provider: 'openrouter',
      model: a.model,
    })),
  };
}

describe('checkModels', () => {
  it('a box on every default is all ok, one row per worker kind and agent', () => {
    const rows = checkModels(defaultBox());
    expect(rows).toHaveLength(MANIFEST_WORKERS.length + MANIFEST_AGENTS.length);
    expect(rows.filter((r) => r.status !== 'ok')).toEqual([]);
    expect(modelCheckReport(rows, '1.2.3').notOk).toBe(0);
  });

  it('reports a worker on another model, with both routes', () => {
    const box = defaultBox();
    box.workers = box.workers.map((w) =>
      w.kind === 'summarizer' ? { ...w, model: 'vendor/other' } : w,
    );
    const row = checkModels(box).find((r) => r.kind === 'worker' && r.name === 'summarizer')!;
    expect(row.status).toBe('drift');
    expect(row.box).toEqual({ provider: 'openrouter', model: 'vendor/other' });
    expect(row.default.model).toBe(MANIFEST_WORKERS.find((w) => w.kind === 'summarizer')!.model);
  });

  it('reports another provider with the same model', () => {
    const box = defaultBox();
    box.agents = box.agents.map((a) => (a.slug === 'assistant' ? { ...a, provider: 'custom' } : a));
    const row = checkModels(box).find((r) => r.kind === 'agent' && r.name === 'assistant')!;
    expect(row.status).toBe('drift');
  });

  it('takes a worker on its declared alt route as ok', () => {
    const tts = MANIFEST_WORKERS.find((w) => w.kind === 'tts')!;
    const box = defaultBox();
    box.workers = box.workers.map((w) =>
      w.kind === 'tts' ? { kind: 'tts', provider: tts.altProvider!, model: tts.altModel! } : w,
    );
    expect(checkModels(box).find((r) => r.name === 'tts')!.status).toBe('ok');
  });

  it('a missing worker and a missing or switched-off agent', () => {
    const box = defaultBox();
    box.workers = box.workers.filter((w) => w.kind !== 'extractor');
    box.agents = box.agents
      .filter((a) => a.slug !== 'pages')
      .map((a) => (a.slug === 'coder' ? { ...a, enabled: false } : a));
    const rows = checkModels(box);
    const extractor = rows.find((r) => r.name === 'extractor')!;
    expect(extractor).toMatchObject({ status: 'missing', required: true, box: null });
    expect(rows.find((r) => r.name === 'pages')!.status).toBe('missing');
    expect(rows.find((r) => r.name === 'coder')!.status).toBe('off');
    expect(modelCheckReport(rows, '1.2.3').notOk).toBe(3);
  });

  it('compares the model ids a worker names in its params (`*_model`)', () => {
    const w: ManifestWorker = {
      kind: 'summarizer',
      name: 'x',
      required: true,
      provider: 'openrouter',
      model: 'a/main',
      params: { fallback_model: 'a/fallback', extract_facts: true } as never,
    };
    const manifest = { workers: [w], agents: [] };
    const same = { kind: 'summarizer', provider: 'openrouter', model: 'a/main' };
    expect(
      checkModels(
        { workers: [{ ...same, params: { fallback_model: 'a/fallback' } }], agents: [] },
        manifest,
      )[0]!.status,
    ).toBe('ok');
    const drift = checkModels(
      { workers: [{ ...same, params: { fallback_model: 'b/other' } }], agents: [] },
      manifest,
    )[0]!;
    expect(drift.status).toBe('drift');
    expect(drift.box?.paramModels).toEqual({ fallback_model: 'b/other' });
    // A param that is not a model id is never compared or reported.
    expect(drift.default.paramModels).toEqual({ fallback_model: 'a/fallback' });
  });
});
