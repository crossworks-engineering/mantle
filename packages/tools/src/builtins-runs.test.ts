import { describe, expect, it } from 'vitest';
// Via the package index, NOT './builtins-runs' directly: the module cycle
// builtins-runs → dispatch → registry → builtins → builtins-runs only
// evaluates cleanly when the registry loads first (the index order).
import { BANNED_ITEM_TOOLS, parsePlan, RUN_TOOLS } from './index';

/**
 * The item ban list must cover every run_* tool (audit 2026-07-21: run_audit
 * was added in slice 2 without being banned, letting a queue item record an
 * audit verdict headlessly — bypassing the fresh-context audit turn). This
 * test makes the list self-maintaining: add a run tool and it fails until
 * the tool is banned as an item too.
 */
describe('runner-queue item ban list', () => {
  it('bans every run_* tool as a queue item', () => {
    for (const tool of RUN_TOOLS) {
      expect(BANNED_ITEM_TOOLS.has(tool.slug), `'${tool.slug}' must be in BANNED_ITEM_TOOLS`).toBe(
        true,
      );
    }
  });

  it('bans delegation as a queue item', () => {
    expect(BANNED_ITEM_TOOLS.has('invoke_agent')).toBe(true);
  });
});

/**
 * The `ask_human` questionnaire form (WP1). These caps are a CONTRACT: the
 * /pending card and the assistant panel render whatever the parser lets
 * through, so an unbounded form becomes an unanswerable screen. Every
 * rejection must also teach the fix (packages/tools/CLAUDE.md).
 */
describe('ask_human form parsing', () => {
  const ask = (payload: Record<string, unknown>) =>
    parsePlan({ kind: 'seq', children: [{ kind: 'ask_human', ...payload }] });

  const firstLeaf = (r: ReturnType<typeof parsePlan>) => {
    if (!r.ok) throw new Error(`expected a valid plan, got: ${r.error}`);
    const leaf = r.plan.children[0] as { payload: Record<string, unknown> };
    return leaf.payload;
  };

  it('keeps the flat options shape working untouched', () => {
    const payload = firstLeaf(ask({ question: 'Which env?', options: ['dev', 'prod'] }));
    expect(payload).toMatchObject({ question: 'Which env?', options: ['dev', 'prod'] });
    expect(payload.form).toBeUndefined();
  });

  it('normalises a form: ids, string-shorthand options, allow_other default', () => {
    const payload = firstLeaf(
      ask({
        question: 'Deploy settings',
        form: {
          questions: [
            {
              header: 'Target env',
              question: 'Which environment?',
              options: ['dev', { label: 'prod', description: 'live traffic' }],
            },
            { question: 'Anything else?', options: ['no'], allow_other: false },
          ],
        },
      }),
    );
    const form = payload.form as { questions: Array<Record<string, unknown>> };
    expect(form.questions).toHaveLength(2);
    // id derived from the header (stable across reordering), options coerced.
    expect(form.questions[0]).toMatchObject({
      id: 'target-env',
      header: 'Target env',
      allow_other: true,
      options: [{ label: 'dev' }, { label: 'prod', description: 'live traffic' }],
    });
    // No header → positional fallback id; explicit opt-out respected.
    expect(form.questions[1]).toMatchObject({ id: 'q2', allow_other: false });
  });

  it('gives duplicate ids a distinct suffix', () => {
    const payload = firstLeaf(
      ask({
        question: 'Twice',
        form: {
          questions: [
            { id: 'pick', question: 'A?', options: ['x'] },
            { id: 'pick', question: 'B?', options: ['y'] },
          ],
        },
      }),
    );
    const form = payload.form as { questions: Array<{ id: string }> };
    expect(form.questions.map((q) => q.id)).toEqual(['pick', 'pick-2']);
  });

  it('refuses more than four questions, and says what to do instead', () => {
    const res = ask({
      question: 'Too much',
      form: {
        questions: Array.from({ length: 5 }, (_, i) => ({ question: `q${i}`, options: ['a'] })),
      },
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toMatch(/at most 4/);
    expect(res.error).toMatch(/later ask_human step/);
  });

  it('refuses too many options and an over-long header', () => {
    const many = ask({
      question: 'q',
      form: {
        questions: [{ question: 'pick', options: Array.from({ length: 9 }, (_, i) => `opt${i}`) }],
      },
    });
    expect(many.ok).toBe(false);
    if (!many.ok) expect(many.error).toMatch(/allow_other/);

    const longHeader = ask({
      question: 'q',
      form: {
        questions: [{ header: 'x'.repeat(25), question: 'pick', options: ['a'] }],
      },
    });
    expect(longHeader.ok).toBe(false);
    if (!longHeader.ok) expect(longHeader.error).toMatch(/at most 24/);
  });

  it('refuses an UNANSWERABLE question (no options, no free-text escape)', () => {
    // The trap: the card would render zero controls for this question and
    // disable submit for the whole form, leaving Reject as the only exit.
    const res = ask({
      question: 'q',
      form: { questions: [{ question: 'Why did it fail?', allow_other: false }] },
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toMatch(/no options/);
    expect(res.error).toMatch(/allow_other/);
    // The same question WITH the escape left on is fine.
    expect(ask({ question: 'q', form: { questions: [{ question: 'Why?' }] } }).ok).toBe(true);
  });

  it('refuses a malformed form rather than silently dropping it', () => {
    expect(ask({ question: 'q', form: { questions: [] } }).ok).toBe(false);
    expect(ask({ question: 'q', form: [] }).ok).toBe(false);
    expect(ask({ question: 'q', form: { questions: [{ options: ['a'] }] } }).ok).toBe(false);
    expect(ask({ question: 'q', form: { questions: [{ question: 'a', options: [{}] }] } }).ok).toBe(
      false,
    );
  });

  it('still requires a headline question alongside a form', () => {
    const res = ask({ form: { questions: [{ question: 'a', options: ['x'] }] } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/non-empty 'question'/);
  });

  it('keeps ask_human seq-only even with a form', () => {
    const res = parsePlan({
      kind: 'par',
      children: [
        { kind: 'ask_human', question: 'q', form: { questions: [{ question: 'a', options: [] }] } },
      ],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/'seq' group/);
  });
});
