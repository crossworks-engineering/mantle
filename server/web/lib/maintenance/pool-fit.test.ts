/**
 * Pool-fit judgement. The report must find a generator sitting in the vision
 * pool, must NOT invent findings where the catalog is silent, and must never
 * disagree with the write guards (it calls the same `poolModelIssue`).
 */
import { describe, expect, it } from 'vitest';
import { classifyFits, classifyOne, summarisePoolFit, type FitSubject } from './pool-fit';

const READER = { input: ['text', 'image'], output: ['text'] };
const GENERATOR = { input: ['image', 'text'], output: ['image', 'text'] };
const TEXT_ONLY = { input: ['text'], output: ['text'] };

const subject = (over: Partial<FitSubject> = {}): FitSubject => ({
  source: 'pool',
  pool: 'vision',
  label: 'Nano Banana Pro',
  model: 'google/gemini-3-pro-image',
  ...over,
});

describe('classifyOne', () => {
  it('flags a generator in the vision pool', () => {
    const v = classifyOne(subject(), GENERATOR);
    expect(v.status).toBe('misfit');
    expect(v.status === 'misfit' && v.reason).toMatch(/OUTPUTS images/);
  });

  it('passes a real reader', () => {
    expect(classifyOne(subject({ model: 'anthropic/claude-opus-5' }), READER).status).toBe('fits');
  });

  it('reports an unknown slug as unchecked, never as a misfit', () => {
    const v = classifyOne(subject(), null);
    expect(v.status).toBe('unchecked');
    expect(v.status === 'unchecked' && v.reason).toMatch(/not in the live OpenRouter catalog/);
  });

  it('reports the meta-router as unchecked — its modalities are a union', () => {
    const v = classifyOne(subject({ pool: 'agents', model: 'openrouter/auto' }), GENERATOR);
    expect(v.status).toBe('unchecked');
    expect(v.status === 'unchecked' && v.reason).toMatch(/meta-router/);
  });

  it('flags a generator on a live worker too', () => {
    const v = classifyOne(subject({ source: 'worker', label: 'Image reader' }), GENERATOR);
    expect(v.status).toBe('misfit');
  });
});

describe('classifyFits + summary', () => {
  const catalog: Record<string, { input: string[]; output: string[] }> = {
    'google/gemini-3-pro-image': GENERATOR,
    'anthropic/claude-opus-5': READER,
    'deepseek/deepseek-chat': TEXT_ONLY,
  };
  const lookup = (m: string) => catalog[m] ?? null;

  const subjects: FitSubject[] = [
    subject(),
    subject({ source: 'worker', label: 'Vision worker' }),
    subject({ pool: 'vision', label: 'Opus', model: 'anthropic/claude-opus-5' }),
    subject({ pool: 'summarizer', label: 'DeepSeek', model: 'deepseek/deepseek-chat' }),
    subject({ pool: 'agents', label: 'Mystery', model: 'vendor/not-listed' }),
  ];

  it('buckets every subject exactly once', () => {
    const r = classifyFits(subjects, lookup);
    expect(r.checked).toBe(5);
    expect(r.misfits).toHaveLength(2);
    expect(r.fits).toHaveLength(2);
    expect(r.unchecked).toHaveLength(1);
  });

  it('calls out the live row in the one-line summary', () => {
    const r = classifyFits(subjects, lookup);
    expect(summarisePoolFit(r)).toBe(
      '5 model(s) checked — 2 misfit(s) (1 on a LIVE agent or worker), 2 fine, 1 not checked',
    );
  });

  it('says nothing is wrong when the catalog is entirely unavailable', () => {
    const r = classifyFits(subjects, () => null);
    expect(r.misfits).toHaveLength(0);
    expect(r.unchecked).toHaveLength(5);
  });
});
