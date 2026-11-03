import { beforeEach, describe, expect, it, vi } from 'vitest';

// The loader with its store stubbed: the open rows and the running decider.
const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  worker: null as null | { model: string; params: unknown },
}));

vi.mock('@mantle/db', () => ({
  countExtractBacklog: vi.fn(async () => 4),
  getDefaultWorker: vi.fn(async () => h.worker),
  getProviderAlert: vi.fn(async (_o: string, s: string) => h.rows.find((r) => r.subject === s)),
  isAlertShown: (r: { visible: boolean; resolvedAt: Date | null }) =>
    r.visible && r.resolvedAt === null,
  isProbedSubject: (s: string) => s === 'embedding' || s === 'extraction',
  listOpenProviderAlerts: vi.fn(async () => h.rows.filter((r) => r.resolvedAt === null)),
}));

import {
  deciderAlertApplies,
  loadDeciderLastFailure,
  loadProviderAlerts,
  splitProviderAlerts,
} from './provider-alerts';

const at = new Date('2026-11-03T08:00:00Z');
const row = (subject: string, model = 'jev', resolvedAt: Date | null = null) => ({
  subject,
  code: 'auth',
  permanent: true,
  reason: 'r',
  provider: 'openrouter',
  model,
  failingSince: at,
  lastErrorAt: at,
  errorCount: 1,
  visible: true,
  paused: false,
  nextProbeAt: null,
  resolvedAt,
});
const decider = (model = 'jev', enabled = true) => ({
  model,
  params: { uses: { passage_scoring: { enabled } } },
});

beforeEach(() => {
  h.rows = [];
  h.worker = decider();
});

describe('deciderAlertApplies', () => {
  it('applies to an open row of the running model with a use on', () => {
    expect(deciderAlertApplies(row('decision'), decider())).toBe(true);
  });
  it('not with no running decider, every use off, or another model', () => {
    expect(deciderAlertApplies(row('decision'), null)).toBe(false);
    expect(deciderAlertApplies(row('decision'), decider('jev', false))).toBe(false);
    expect(deciderAlertApplies(row('decision'), { model: 'jev', params: null as never })).toBe(
      false,
    );
    expect(deciderAlertApplies(row('decision', 'old'), decider())).toBe(false);
  });
  it('not to a closed row', () => {
    expect(deciderAlertApplies(row('decision', 'jev', at), decider())).toBe(false);
  });
});

describe('loadProviderAlerts', () => {
  it('keeps a decision alert while it applies', async () => {
    h.rows = [row('decision'), row('embedding')];
    const list = await loadProviderAlerts('o1');
    expect(list.map((a) => a.subject)).toEqual(['decision', 'embedding']);
    expect(list.find((a) => a.subject === 'embedding')?.waiting).toBe(4);
    expect(list.find((a) => a.subject === 'decision')?.waiting).toBeNull();
  });
  it('drops it once no decision runs that could close it', async () => {
    h.rows = [row('decision'), row('model_policy')];
    h.worker = null;
    expect((await loadProviderAlerts('o1')).map((a) => a.subject)).toEqual(['model_policy']);
    h.worker = decider('other');
    expect((await loadProviderAlerts('o1')).map((a) => a.subject)).toEqual(['model_policy']);
  });
});

describe('splitProviderAlerts', () => {
  it('keeps only the probed subjects in alerts', async () => {
    h.rows = [row('decision'), row('embedding'), row('extraction'), row('model_policy')];
    const body = splitProviderAlerts(await loadProviderAlerts('o1'));
    expect(body.alerts.map((a) => a.subject)).toEqual(['embedding', 'extraction']);
    expect(body.otherAlerts.map((a) => a.subject)).toEqual(['decision', 'model_policy']);
  });
});

describe('loadDeciderLastFailure', () => {
  it('says whether the open row is about the decider that runs now', async () => {
    h.rows = [row('decision')];
    expect((await loadDeciderLastFailure('o1'))?.current).toBe(true);
    h.worker = decider('other');
    expect((await loadDeciderLastFailure('o1'))?.current).toBe(false);
  });
  it('a closed row is history, never current', async () => {
    h.rows = [row('decision', 'jev', at)];
    const f = await loadDeciderLastFailure('o1');
    expect(f?.resolvedAt).toBe(at.toISOString());
    expect(f?.current).toBe(false);
  });
});
