/**
 * The view side of phase 6 on what the check side writes, through the
 * check side's exported contract only (@mantle/diagram-templates: the
 * PidCheck mark, mapImageChecks, markSealBody, provenanceSealBody;
 * @mantle/content/drawing-seal: drawingSeal and the save's
 * honestCanvasSource): a traced circuit (synthetic sheets, the check
 * branch's fixtures), its marks answered and sealed as circuit_trace seals
 * them, passes the pid check, survives a save, and draws in both styles;
 * every mark is a `data-check` key with its evidence; the "N guesses not
 * checked by image" note is counted from the marks at render time, never
 * from a stored `checks`; the crops the marks name are embedded, sealed,
 * and kept by the save.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCanvas,
  checkCropIds,
  checkStaticSvg,
  estimateMeasurer,
  imageCheckSummary,
  mapImageChecks,
  markSealBody,
  provenanceSealBody,
  readCanvasAssets,
  readCanvasData,
  render,
  validate,
  withImageCheckSummary,
  type PidCheck,
} from '@mantle/diagram-templates';
import { drawingSeal, honestCanvasSource } from '@mantle/content/drawing-seal';
import { CIRCUIT, genericValveSheet, readingSheets } from './circuit-trace/fixtures';
import { traceCircuit, type SheetInput } from './circuit-trace/walk';
import { embedCheckCrops, type CropRead } from './present-crops';

beforeEach(() => {
  vi.stubEnv('MANTLE_MASTER_KEY', 'present-view-test-key');
  vi.stubEnv('MANTLE_MASTER_KEY_NEXT', undefined);
});
afterEach(() => vi.unstubAllEnvs());

const CROP = '0f0f0f0f-0000-4000-8000-000000000001';
// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const read: CropRead = async () => ({ bytes: PNG, mimeType: 'image/png' });

type Obj = Record<string, unknown>;
type Answer = ['yes' | 'no' | 'unsure', string] | null;

/** Each drawing of pid data (one, or a set's pages). */
function eachDrawing(pid: Obj, fn: (d: Obj) => Obj): Obj {
  return Array.isArray(pid.pages)
    ? { ...pid, pages: (pid.pages as Obj[]).map((p) => ({ ...p, data: fn(p.data as Obj) })) }
    : fn(pid);
}

/** The traced drawing (the tracer's public entry, without the image check
 *  hook) with an unchecked mark, by the contract, on each connector (an
 *  end), each line (a join) and each line's first inline item (a valve). */
function marked(pid: Obj): Obj {
  let n = 0;
  const mark = (kind: PidCheck['kind'], guess: string): PidCheck => ({
    key: `g${(n++).toString(36)}`,
    kind,
    state: 'unchecked',
    guess,
  });
  return eachDrawing(pid, (d) => ({
    ...d,
    ...(Array.isArray(d.offpage)
      ? {
          offpage: (d.offpage as Obj[]).map((o) => ({
            ...o,
            check: mark('end', 'near the vessel'),
          })),
        }
      : {}),
    lines: ((d.lines as Obj[] | undefined) ?? []).map((l) => {
      const inline = Array.isArray(l.inline) ? (l.inline as Obj[]) : [];
      return {
        ...l,
        checks: [mark('join', 'one pipe')],
        ...(inline.length
          ? { inline: [{ ...inline[0], check: mark('valve', 'gate valve') }, ...inline.slice(1)] }
          : {}),
      };
    }),
  }));
}

/** The traced drawing with the `answer(i)` of its i-th mark written as the
 *  contract's mark (PidCheck), then sealed as circuit_trace seals it: a
 *  provenance over every key, each mark's seal under it. */
function traced(sheets: SheetInput[], answer: (i: number) => Answer): Obj {
  const pid = marked(traceCircuit(CIRCUIT, sheets).pid as Obj);
  let i = 0;
  const keys: string[] = [];
  const answered = eachDrawing(pid, (d) =>
    mapImageChecks(d, (m) => {
      const c = m as PidCheck;
      keys.push(c.key);
      const a = answer(i++);
      if (!a) return c;
      const [ans, alt] = a;
      const mark: PidCheck = {
        key: c.key,
        kind: c.kind,
        state:
          ans === 'yes'
            ? 'checked'
            : ans === 'unsure'
              ? 'unsure'
              : alt
                ? 'corrected'
                : 'contradicted',
        ...(c.guess !== undefined ? { guess: c.guess } : {}),
        question: 'Is this what the drawing reads?',
        answer: ans,
        ...(alt ? { alt } : {}),
        reason: 'what the crop shows',
        model: 'test/vision-model',
        checkedAt: '2026-10-26T09:00:00.000Z',
        crops: [CROP],
      };
      return mark;
    }),
  );
  const id = '0123456789abcdef';
  const provenance = { id, keys: [...new Set(keys)] };
  const sealed = eachDrawing(answered, (d) =>
    mapImageChecks(d, (m) => ({ ...(m as Obj), sig: drawingSeal(markSealBody(id, m as Obj)) })),
  );
  return {
    ...sealed,
    provenance: { ...provenance, sig: drawingSeal(provenanceSealBody(provenance)) },
  };
}

/** Each drawing of the data with the picture it drew (a set: its pages). */
function drawn(data: Obj, r: { svg: string; pages?: { svg: string }[] }) {
  return Array.isArray(data.pages)
    ? (data.pages as Obj[]).map((p, i) => ({ data: p.data as Obj, svg: r.pages![i]!.svg }))
    : [{ data, svg: r.svg }];
}

/** The canvas a present_create of this data stores: the crops embedded,
 *  then the save's normalization. */
async function saved(pid: Obj): Promise<string> {
  const bare = buildCanvas({ template: 'pid', data: pid, mode: 'import' });
  const { assets } = await embedCheckCrops(pid, read, { room: 900_000 });
  const html = assets ? buildCanvas({ template: 'pid', data: pid, mode: 'import', assets }) : bare;
  return honestCanvasSource(html);
}

const cases: [string, () => Obj][] = [
  ['unanswered guesses', () => traced(readingSheets(), () => null)],
  ['a corrected valve', () => traced([genericValveSheet()], () => ['no', 'orifice'])],
  [
    'answers of every kind',
    () => traced(readingSheets(), (i) => (i % 2 ? ['yes', ''] : ['no', ''])),
  ],
];

describe.each(cases)('a traced circuit: %s', (_name, make) => {
  it('survives a save, passes the pid check and draws in both styles, every mark a key with its evidence', async () => {
    const pid = make();
    const html = await saved(pid);
    const stored = readCanvasData(html);
    // The save kept every sealed mark: the counts are the traced ones.
    expect(imageCheckSummary(stored)).toEqual(imageCheckSummary(pid));
    expect(validate('pid', stored).ok).toBe(true);
    const summary = imageCheckSummary(stored);
    expect(summary).not.toBeNull();
    // The crops the kept marks name are kept, sealed.
    expect(Object.keys(readCanvasAssets(html).crops)).toEqual(checkCropIds(stored));
    for (const style of [1, 2]) {
      const r = render('pid', { ...stored, style }, estimateMeasurer);
      if (!r.ok) throw new Error(r.errors.join('\n'));
      expect(r.failed ?? []).toEqual([]);
      expect(checkStaticSvg(r.svg)).toEqual([]);
      const evidence = [...(r.checks ?? []), ...(r.pages ?? []).flatMap((p) => p.checks ?? [])];
      expect(evidence.length).toBeGreaterThan(0);
      for (const e of evidence) expect(r.svg).toContain(`data-check="${e.key}"`);
      const marks = evidence.flatMap((e) => e.checks);
      expect(new Set(marks.map((c) => c.key)).size).toBeLessThanOrEqual(summary!.guesses);
      // Each drawing (a set: each page) says its own marks' count.
      for (const { data, svg } of drawn(stored, r)) {
        const unchecked = imageCheckSummary(data)?.unchecked ?? 0;
        if (unchecked)
          expect(svg).toMatch(new RegExp(`>${unchecked} GUESS(ES)? NOT CHECKED BY IMAGE<`));
        else expect(svg).not.toContain('NOT CHECKED BY IMAGE');
      }
    }
  });
});

describe('the unchecked note is the marks own count', () => {
  it('a stored count that disagrees with the marks is never shown', () => {
    const pid = traced([genericValveSheet()], () => null);
    expect(pid.pages).toBeUndefined();
    const real = imageCheckSummary(pid)!;
    expect(real.unchecked).toBeGreaterThan(0);
    // A canvas edited through its source: zero claimed, the marks say more.
    const lying = {
      ...withImageCheckSummary(pid),
      checks: { ...real, unchecked: 0, checked: real.guesses },
    };
    const r = render('pid', lying, estimateMeasurer);
    if (!r.ok) throw new Error(r.errors.join('\n'));
    expect(r.svg).toMatch(new RegExp(`>${real.unchecked} GUESS(ES)? NOT CHECKED BY IMAGE<`));
  });

  it('the crops the marks name are the ones a save embeds; a forged one is dropped', async () => {
    const pid = traced([genericValveSheet()], () => ['no', 'orifice']);
    expect(checkCropIds(pid)).toEqual([CROP]);
    const html = await saved(pid);
    const kept = readCanvasAssets(html).crops[CROP]!;
    expect(kept).toBeTruthy();
    // Another picture under the same seal, written into the source: a save drops it.
    const forged = html.replace(kept.src, `${kept.src.slice(0, -8)}AAAAAAA=`);
    expect(readCanvasAssets(honestCanvasSource(forged)).crops).toEqual({});
  });
});
