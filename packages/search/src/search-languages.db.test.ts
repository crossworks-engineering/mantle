/**
 * Search languages on a real Postgres (plan page 0a1eab17, step 4): a
 * made-up mixed corpus of English and Spanish passages, searched in English
 * with the setting off and with `es`, the model call stubbed (a fixed
 * dictionary, with a set delay for an uncached call).
 *
 *  - with `es`, each English query finds its Spanish passage by its words
 *    (the keyword arm ranks it), which it does not with the setting off;
 *  - with the setting off, the English passages rank as before;
 *  - a translation slower than the budget never makes a search slower than
 *    the budget (plus the search itself);
 *  - the numbers (keyword-arm and final ranks, the added time per search,
 *    cached and not) are printed for the plan's measure.
 *
 * Seeds its own rows on the shared anchor and removes them after; the
 * setting is on only inside each measure and cleared after.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/search/src/search-languages.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** Made-up maintenance passages. Each query's target is a Spanish one. */
const SPANISH = [
  'La válvula de alivio de presión PSV-210 se calibró a 12 bar durante la parada de mantenimiento.',
  'El intercambiador de calor E-301 mostró ensuciamiento en los tubos; se programó una limpieza química.',
  'La bomba centrífuga P-104 presentó vibración excesiva en el rodamiento del lado acoplado.',
  'Se detectó corrosión bajo aislamiento en la línea de vapor de baja presión del sector norte.',
  'El procedimiento de bloqueo y etiquetado exige verificar energía cero antes de abrir la brida.',
  'La inspección por ultrasonido midió un espesor mínimo de pared de 6,2 mm en el codo de salida.',
];
const ENGLISH = [
  'Pressure relief valve PSV-305 passed its bench test at 8 bar after the turnaround.',
  'Heat exchanger E-410 tubes were cleaned with a hydro jet; no fouling remained.',
  'Centrifugal pump P-220 seal flush line was rerouted to stop the vibration alarm.',
  'Insulation on the steam header was replaced; no corrosion was found below it.',
  'Lockout and tagout training is due for the night shift crew next month.',
  'Ultrasonic wall thickness readings on the drum showed no loss since last year.',
];
const FILLER_EN = Array.from(
  { length: 24 },
  (_, i) =>
    `Shift log ${i}: the operators walked the unit, checked the gauges and wrote the handover notes.`,
);
const FILLER_ES = Array.from(
  { length: 24 },
  (_, i) =>
    `Registro de turno ${i}: los operadores recorrieron la unidad, revisaron los manómetros y escribieron las notas.`,
);

/** The English queries, each with the stub's Spanish and its target. */
const QUERIES = [
  {
    q: 'pressure relief valve calibration',
    es: 'calibración de la válvula de alivio de presión',
    target: 0,
  },
  {
    q: 'heat exchanger tube fouling',
    es: 'ensuciamiento de los tubos del intercambiador de calor',
    target: 1,
  },
  {
    q: 'centrifugal pump bearing vibration',
    es: 'vibración del rodamiento de la bomba centrífuga',
    target: 2,
  },
  {
    q: 'corrosion under insulation on the steam line',
    es: 'corrosión bajo aislamiento en la línea de vapor',
    target: 3,
  },
  {
    q: 'lockout tagout zero energy before opening a flange',
    es: 'bloqueo y etiquetado, energía cero antes de abrir una brida',
    target: 4,
  },
  {
    q: 'ultrasonic wall thickness at the elbow',
    es: 'espesor de pared por ultrasonido en el codo',
    target: 5,
  },
];

/** A fixed unit vector per seed (no model): the vector arm is noise here,
 *  as for a corpus the query does not embed near. */
function vec(seed: number): number[] {
  let x = seed * 2654435761 || 1;
  const v = Array.from({ length: 768 }, () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648 - 0.5;
  });
  const n = Math.hypot(...v);
  return v.map((a) => a / n);
}

describe.skipIf(!URL)('search languages on a mixed English and Spanish corpus', () => {
  let m: typeof import('@mantle/db');
  let s: typeof import('./index');
  let t: typeof import('./query-translate');
  let ts: typeof import('@mantle/db/test-support');
  let su: ReturnType<typeof import('@mantle/db/test-support').superuserClient>;
  let anchor = '';
  const tag = randomUUID().slice(0, 8);
  const spanishIds = SPANISH.map(() => randomUUID());
  const englishIds = ENGLISH.map(() => randomUUID());
  const fillerIds = [...FILLER_EN, ...FILLER_ES].map(() => randomUUID());
  const allIds = [...spanishIds, ...englishIds, ...fillerIds];
  const bulkId = randomUUID();
  let translateDelayMs = 0;
  let translateCalls = 0;

  /** The anchor's preferences before this file, put back after it. */
  let savedPrefs: string | null = null;
  const setLanguages = async (langs: string[]) => {
    // `::text::jsonb`: a bare `::jsonb` makes the driver send the JSON text
    // as a JSON string.
    await su`update profiles
                set preferences = preferences || ${JSON.stringify({ searchLanguages: langs })}::text::jsonb
              where user_id = ${anchor}`;
  };

  const search = (q: string, i: number) =>
    m.asSystem(
      () =>
        s.searchChunksExplained({
          ownerId: anchor,
          q,
          embedding: vec(1000 + i),
          limit: 10,
          nodeIds: allIds,
          translate: true,
        }),
      'test',
    );

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    ts = await import('@mantle/db/test-support');
    m = await import('@mantle/db');
    s = await import('./index');
    t = await import('./query-translate');
    su = ts.superuserClient(URL!, 1);
    anchor = await ts.ensureTestAnchor(su);
    await su`insert into profiles (user_id) values (${anchor}) on conflict do nothing`;
    const [p] = await su<{ prefs: string }[]>`
      select preferences::text as prefs from profiles where user_id = ${anchor}`;
    savedPrefs = p?.prefs ?? null;
    const texts = [...SPANISH, ...ENGLISH, ...FILLER_EN, ...FILLER_ES];
    for (const [i, id] of allIds.entries()) {
      await su`insert into nodes (id, owner_id, type, title, path)
               values (${id}, ${anchor}, 'page', ${`sl-${tag} ${i}`}, 'pages')`;
      await su`insert into content_chunks (owner_id, node_id, ordinal, text, embedding)
               values (${anchor}, ${id}, 0, ${texts[i]!}, ${`[${vec(i).join(',')}]`}::vector)`;
    }
    // The keyword arm reads the table's size and word stats (pg_class,
    // pg_stats), as autovacuum keeps them on a brain.
    await su`analyze content_chunks`;
    const dictionary = new Map(QUERIES.map((x) => [x.q, x.es]));
    t.setQueryTranslatorForTests({
      call: async (_route, _system, user) => {
        translateCalls++;
        if (translateDelayMs) await new Promise((r) => setTimeout(r, translateDelayMs));
        return dictionary.get(user) ?? user;
      },
    });
  }, 120_000);

  afterAll(async () => {
    t?.setQueryTranslatorForTests(null);
    if (su) {
      if (savedPrefs !== null) {
        await su`update profiles set preferences = ${savedPrefs}::text::jsonb
                  where user_id = ${anchor}`;
      }
      const every = `{${[...allIds, bulkId].join(',')}}`;
      await su`delete from content_chunks where node_id = any(${every}::uuid[])`;
      await su`delete from nodes where id = any(${every}::uuid[])`;
      await su.end();
    }
    await m?.closeDb();
  });

  type Row = {
    query: string;
    arm: string;
    kr: number | null;
    final: number | null;
    en: { kr: number | null; final: number | null };
    ms: number;
  };
  const rankOf = (
    hits: Awaited<ReturnType<typeof search>>['hits'],
    nodeId: string,
  ): { kr: number | null; final: number | null } => {
    const at = hits.findIndex((h) => h.nodeId === nodeId);
    return { kr: at >= 0 ? (hits[at]!.arms.kr ?? null) : null, final: at >= 0 ? at + 1 : null };
  };

  it('finds the Spanish passages by their words with es set, and not without', async () => {
    const rows: Row[] = [];
    const timed = async (q: string, i: number) => {
      const t0 = performance.now();
      const r = await search(q, i);
      return { r, ms: performance.now() - t0 };
    };

    // Off: today's search. Twice each, the second timed (warm plans).
    await setLanguages([]);
    const offMs: number[] = [];
    for (const [i, x] of QUERIES.entries()) {
      await timed(x.q, i);
      const { r, ms } = await timed(x.q, i);
      offMs.push(ms);
      rows.push({
        query: x.q,
        arm: 'off',
        ...rankOf(r.hits, spanishIds[x.target]!),
        en: rankOf(r.hits, englishIds[x.target]!),
        ms,
      });
      // The English passage on the same subject is the word arm's, as before.
      expect(rankOf(r.hits, spanishIds[x.target]!).kr).toBeNull();
    }
    expect(translateCalls).toBe(0);

    // On: uncached (the stub waits 400 ms, a fast model's round trip), then cached.
    await setLanguages(['es']);
    translateDelayMs = 400;
    const coldMs: number[] = [];
    const warmMs: number[] = [];
    for (const [i, x] of QUERIES.entries()) {
      const cold = await timed(x.q, i);
      coldMs.push(cold.ms);
      rows.push({
        query: x.q,
        arm: 'es, not cached',
        ...rankOf(cold.r.hits, spanishIds[x.target]!),
        en: rankOf(cold.r.hits, englishIds[x.target]!),
        ms: cold.ms,
      });
      const warm = await timed(x.q, i);
      warmMs.push(warm.ms);
      rows.push({
        query: x.q,
        arm: 'es, cached',
        ...rankOf(warm.r.hits, spanishIds[x.target]!),
        en: rankOf(warm.r.hits, englishIds[x.target]!),
        ms: warm.ms,
      });
    }
    expect(translateCalls).toBe(QUERIES.length);
    translateDelayMs = 0;
    await setLanguages([]);

    const avg = (a: number[]) => Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10;
    console.log(
      `[search-languages measure]\n${rows
        .map(
          (r) =>
            `${r.arm.padEnd(15)} es kr=${String(r.kr ?? '-').padEnd(3)} final=${String(r.final ?? '-').padEnd(3)} | en kr=${String(r.en.kr ?? '-').padEnd(3)} final=${String(r.en.final ?? '-').padEnd(3)} ${r.ms.toFixed(1)} ms  ${r.query}`,
        )
        .join('\n')}\n` +
        `average per search: off ${avg(offMs)} ms, es not cached ${avg(coldMs)} ms (stub 400 ms), es cached ${avg(warmMs)} ms`,
    );
    // Every Spanish passage is found by its words with es, cached or not.
    for (const r of rows.filter((x) => x.arm !== 'off'))
      expect(r.kr, `${r.arm}: ${r.query}`).not.toBeNull();
  }, 120_000);

  it('a mostly English brain: the translation’s stop words ("de", "la") find nothing', async () => {
    // 900 more English passages: the Spanish ones are now about 3%, so "de"
    // and "la" would count as rare. Under the Spanish stop list they are no
    // terms, and no Spanish shift log (which holds them, and no query word)
    // comes back from the word arm.
    await su`insert into nodes (id, owner_id, type, title, path)
             values (${bulkId}, ${anchor}, 'page', ${`sl-${tag} bulk`}, 'pages')`;
    await su`insert into content_chunks (owner_id, node_id, ordinal, text, embedding)
             select ${anchor}, ${bulkId}, g,
                    'Daily round ' || g || ': the crew checked the pumps and the tanks.',
                    ${`[${vec(7).join(',')}]`}::vector
               from generate_series(0, 899) g`;
    await su`analyze content_chunks`;
    const ids = [...allIds, bulkId];
    await setLanguages(['es']);
    try {
      const r = await m.asSystem(
        () =>
          s.searchChunksExplained({
            ownerId: anchor,
            q: QUERIES[0]!.q,
            embedding: vec(1000),
            limit: 50,
            nodeIds: ids,
            translate: true,
          }),
        'test',
      );
      const fillerEs = new Set<string>(fillerIds.slice(FILLER_EN.length));
      const wordHits = r.hits.filter((h) => h.arms.kr !== undefined);
      expect(wordHits.some((h) => h.nodeId === spanishIds[0])).toBe(true);
      expect(wordHits.filter((h) => fillerEs.has(h.nodeId))).toEqual([]);
    } finally {
      await setLanguages([]);
    }
  }, 60_000);

  it('a translation slower than the budget never makes the search slower than the budget', async () => {
    await setLanguages(['es']);
    translateDelayMs = 5000;
    try {
      const t0 = performance.now();
      const r = await search('flange gasket leak at the outlet', 99);
      const ms = performance.now() - t0;
      console.log(
        `[search-languages measure] slow translation (5 s stub): search took ${ms.toFixed(0)} ms`,
      );
      expect(ms).toBeLessThan(t.TRANSLATE_BUDGET_MS + 1000);
      expect(Array.isArray(r.hits)).toBe(true);
    } finally {
      translateDelayMs = 0;
      await setLanguages([]);
    }
  }, 30_000);
});
