import { describe, expect, it } from 'vitest';
import {
  TIER1_MAX_CHARS,
  isSmallTalk,
  journalTiersOf,
  pickJournalEntries,
  planJournalTier1,
  renderIdentityBlock,
  renderJournalTier1Block,
  renderPurposeBlock,
  renderRelevantJournalBlock,
  renderWorkingNotesBlock,
  visibleToAgent,
  type JournalCandidate,
  type IdentityEntry,
  type WorkingNoteEntry,
} from './identity-context';

const e = (body: string, kind: string | null = null): IdentityEntry => ({ body, kind });

const w = (
  body: string,
  kind: string,
  agentSlug: string | null = null,
  status: string | null = null,
): WorkingNoteEntry => ({ body, kind, agentSlug, status });

/** Count rendered bullet lines (each entry is one `- ` line). */
const bulletCount = (block: string) => block.split('\n').filter((l) => l.startsWith('- ')).length;

describe('renderPurposeBlock', () => {
  it('returns an empty string for a blank purpose', () => {
    expect(renderPurposeBlock('', 'Personal brain')).toBe('');
    expect(renderPurposeBlock('   ', null)).toBe('');
  });

  it('renders the header and the purpose text', () => {
    const block = renderPurposeBlock('Analyse RBI inspection reports.', null);
    expect(block).toContain('# Purpose of this brain');
    expect(block).toContain('Analyse RBI inspection reports.');
  });

  it('includes a Speciality line when an archetype label is given', () => {
    const block = renderPurposeBlock('Analyse data.', 'Data / RBI analytics');
    expect(block).toContain('**Speciality:** Data / RBI analytics');
  });

  it('omits the Speciality line when the label is null', () => {
    const block = renderPurposeBlock('Analyse data.', null);
    expect(block).not.toContain('**Speciality:**');
  });

  it('collapses whitespace and truncates a very long purpose with an ellipsis', () => {
    const block = renderPurposeBlock('word '.repeat(400).trim(), null);
    expect(block).toContain('…');
    // 600-char cap on the purpose body itself.
    const body = block.split('\n').pop()!;
    expect(body.length).toBeLessThanOrEqual(600);
  });
});

describe('renderIdentityBlock', () => {
  it('returns an empty string when there are no entries', () => {
    expect(renderIdentityBlock([])).toBe('');
  });

  it('returns an empty string when every entry has an empty body', () => {
    expect(renderIdentityBlock([e(''), e('   '), e('\n')])).toBe('');
  });

  it('renders the header, a kind heading, and the bullet', () => {
    const block = renderIdentityBlock([e('I value honesty.', 'identity')]);
    expect(block).toContain('# About the user (Journal)');
    expect(block).toContain('## Identity');
    expect(block).toContain('- I value honesty.');
  });

  it('never renders a mood tag (moods are gone)', () => {
    const block = renderIdentityBlock([e('I run a small business.', 'context')]);
    expect(block).not.toContain('_(felt:');
  });

  it('groups by the canonical kind order (identity before goal)', () => {
    const block = renderIdentityBlock([e('ship the MVP', 'goal'), e('father', 'identity')]);
    expect(block.indexOf('## Identity')).toBeLessThan(block.indexOf('## Goal'));
  });

  it('buckets unknown / blank kinds into a trailing "Other"', () => {
    const block = renderIdentityBlock([e('knows aluminium', 'hobbies'), e('a goal', 'goal')]);
    expect(block).toContain('## Other');
    expect(block.indexOf('## Goal')).toBeLessThan(block.indexOf('## Other'));
  });

  it('caps each kind at 6 entries', () => {
    const many = Array.from({ length: 10 }, (_, i) => e(`context note ${i}`, 'context'));
    const block = renderIdentityBlock(many);
    expect(bulletCount(block)).toBe(6);
  });

  it('caps the total at 30 entries across all groups', () => {
    // 4 user kinds × 6 each = 24, plus 6 unknown-kind entries in "Other" = 30
    // eligible exactly at the cap; add extras to prove the clamp.
    const many: IdentityEntry[] = [];
    for (const k of ['identity', 'context', 'preference', 'goal', 'misc-a', 'misc-b'])
      for (let i = 0; i < 8; i++) many.push(e(`${k} note ${i}`, k));
    const block = renderIdentityBlock(many);
    expect(bulletCount(block)).toBe(30);
  });

  it('collapses whitespace and truncates a very long body with an ellipsis', () => {
    const block = renderIdentityBlock([e('word '.repeat(200).trim(), 'context')]);
    const bullet = block.split('\n').find((l) => l.startsWith('- '))!;
    expect(bullet).toContain('…');
    // 280-char cap (+ "- " prefix); generously bounded, never the full 1000 chars.
    expect(bullet.length).toBeLessThanOrEqual(2 + 280);
    expect(bullet).not.toContain('  '); // no double spaces left
  });
});

describe('renderWorkingNotesBlock', () => {
  it('returns an empty string when there are no entries', () => {
    expect(renderWorkingNotesBlock([])).toBe('');
    expect(renderWorkingNotesBlock([w('', 'lesson')])).toBe('');
  });

  it('renders expectations, lessons, and open questions under their headings', () => {
    const block = renderWorkingNotesBlock([
      w('The user expects terse replies.', 'expectation'),
      w('Bulk table writes need table_rows_add.', 'lesson'),
      w('What timezone does the user work in?', 'gap', null, 'open'),
    ]);
    expect(block).toContain('# Working notes (Journal)');
    expect(block.indexOf('## Expectations')).toBeLessThan(block.indexOf('## Lessons'));
    expect(block.indexOf('## Lessons')).toBeLessThan(block.indexOf('## Open questions'));
    expect(block).toContain('- The user expects terse replies.');
    expect(block).toContain('- What timezone does the user work in?');
  });

  it('drops resolved gaps from the open-questions tail', () => {
    const block = renderWorkingNotesBlock([
      w('answered already', 'gap', null, 'resolved'),
      w('still open', 'gap', null, 'open'),
    ]);
    expect(block).toContain('- still open');
    expect(block).not.toContain('answered already');
  });

  it('attributes a note learned by ANOTHER agent, not one learned by this agent', () => {
    const block = renderWorkingNotesBlock(
      [
        w('Always cite the trace.', 'expectation', 'pages'),
        w('Own note.', 'expectation', 'responder'),
      ],
      'responder',
    );
    expect(block).toContain('- Always cite the trace. _(learned by pages)_');
    expect(block).toContain('- Own note.');
    expect(block).not.toContain('Own note. _(learned by');
  });

  it('caps expectations/lessons at 6 each and open questions at 5', () => {
    const entries: WorkingNoteEntry[] = [
      ...Array.from({ length: 10 }, (_, i) => w(`exp ${i}`, 'expectation')),
      ...Array.from({ length: 10 }, (_, i) => w(`les ${i}`, 'lesson')),
      ...Array.from({ length: 10 }, (_, i) => w(`gap ${i}`, 'gap', null, 'open')),
    ];
    const block = renderWorkingNotesBlock(entries);
    expect(bulletCount(block)).toBe(6 + 6 + 5);
  });

  it('ignores user-lane and unknown kinds entirely', () => {
    expect(renderWorkingNotesBlock([w('who I am', 'identity'), w('misc', 'whatever')])).toBe('');
  });
});

describe('renderJournalTier1Block + planJournalTier1', () => {
  let n = 0;
  const t = (body: string, kind: string | null) => ({ nodeId: `n${n++}`, body, kind });

  it('keeps identity, goal and preference only, grouped, oldest first, full text', () => {
    const long = 'x'.repeat(900);
    const block = renderJournalTier1Block(
      '',
      planJournalTier1([
        t('Old identity', 'identity'),
        t('A context entry', 'context'),
        t('Wants to ship v1', 'goal'),
        t(long, 'identity'),
        t('Terse replies', 'preference'),
        t('A lesson', 'lesson'),
      ]),
    );
    expect(block).toMatch(/^# About the user \(Journal\)/);
    expect(block).not.toMatch(/context entry|A lesson/);
    expect(block.indexOf('Old identity')).toBeLessThan(block.indexOf(long));
    expect(block.indexOf('## Identity')).toBeLessThan(block.indexOf('## Goal'));
    expect(block.indexOf('## Goal')).toBeLessThan(block.indexOf('## Preference'));
    expect(block).toContain(long); // not cut at 280 like the old block
  });

  it('puts the purpose first and returns only the purpose when no entry qualifies', () => {
    const purpose = renderPurposeBlock('Run the plant docs', null);
    expect(renderJournalTier1Block(purpose, planJournalTier1([t('ctx', 'context')]))).toBe(purpose);
    expect(renderJournalTier1Block('', planJournalTier1([]))).toBe('');
  });

  it('a long identity group cannot starve the preferences (the audit case)', () => {
    const identity = Array.from({ length: 49 }, (_, i) =>
      t(`who ${i} ${'i'.repeat(160)}`, 'identity'),
    );
    const prefs = Array.from({ length: 20 }, (_, i) =>
      t(`pref ${i} ${'p'.repeat(100)}`, 'preference'),
    );
    const plan = planJournalTier1([...identity, ...prefs]);
    expect(plan.shown.filter((e) => e.kind === 'preference')).toHaveLength(20);
    expect(plan.chars).toBeLessThanOrEqual(TIER1_MAX_CHARS);
    // What did not fit is not lost: it overflows to tier 2.
    expect(plan.shown.length + plan.overflow.length).toBe(69);
    expect(plan.overflow.every((e) => e.kind === 'identity')).toBe(true);
  });

  it('a new entry never displaces an older one of its kind', () => {
    const base = Array.from({ length: 30 }, (_, i) =>
      t(`pref ${i} ${'p'.repeat(150)}`, 'preference'),
    );
    const before = planJournalTier1(base).shown.map((e) => e.nodeId);
    const after = planJournalTier1([...base, t('newest pref', 'preference')]).shown.map(
      (e) => e.nodeId,
    );
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it('marks an entry cut to the entry cap as not whole', () => {
    const plan = planJournalTier1([t('y'.repeat(2000), 'identity'), t('short', 'goal')]);
    expect(plan.shown.map((e) => e.whole)).toEqual([false, true]);
  });
});

describe('visibleToAgent and journalTiersOf', () => {
  it("an agent sees its own and unowned entries, never another agent's; gaps are brain-wide", () => {
    expect(visibleToAgent({ kind: 'lesson', agentSlug: 'a' }, 'a')).toBe(true);
    expect(visibleToAgent({ kind: 'lesson', agentSlug: null }, 'a')).toBe(true);
    expect(visibleToAgent({ kind: 'preference', agentSlug: 'b' }, 'a')).toBe(false);
    expect(visibleToAgent({ kind: 'gap', agentSlug: 'b' }, 'a')).toBe(true);
    expect(visibleToAgent({ kind: 'lesson', agentSlug: 'b' }, null)).toBe(true);
  });

  it('notes_target = journal implies live tiers', () => {
    expect(journalTiersOf({})).toBe('shadow');
    expect(journalTiersOf({ journal_tiers: 'off' })).toBe('off');
    expect(journalTiersOf({ journal_tiers: 'bogus' })).toBe('shadow');
    expect(journalTiersOf({ notes_target: 'journal' })).toBe('live');
    expect(journalTiersOf({ notes_target: 'journal', journal_tiers: 'off' })).toBe('live');
  });
});

describe('isSmallTalk', () => {
  it('skips greetings, thanks and one-word acknowledgements', () => {
    for (const t of ['hi', 'Thanks!', 'thank you so much', 'ok', 'Good morning', 'cool.', 'yes'])
      expect(isSmallTalk(t)).toBe(true);
  });
  it('keeps real messages, however short', () => {
    for (const t of ["I'm not feeling well", 'feeling sick', 'why?', 'draft the SOP header'])
      expect(isSmallTalk(t)).toBe(false);
  });
  it('a one-word request is not small talk; emoji alone is', () => {
    for (const t of ['invoices', 'budget', 'Deploy', 'schedule?'])
      expect(isSmallTalk(t)).toBe(false);
    for (const t of ['👍', '!!', '...']) expect(isSmallTalk(t)).toBe(true);
  });
});

describe('pickJournalEntries', () => {
  const c = (
    nodeId: string,
    kind: string,
    similarity: number,
    body = `${nodeId} body`,
    extra: Partial<JournalCandidate> = {},
  ): JournalCandidate => ({
    nodeId,
    kind,
    similarity,
    body,
    agentSlug: null,
    status: null,
    ...extra,
  });

  it('picks tier 2 kinds at or above the cutoff, best first; tier 1 kinds never', () => {
    const r = pickJournalEntries(
      [
        c('a', 'context', 0.71),
        c('b', 'lesson', 0.9),
        c('i', 'identity', 0.99),
        c('d', 'context', 0.5),
      ],
      { cutoff: 0.7, budgetChars: 3000 },
    );
    expect(r.picks.map((p) => p.nodeId)).toEqual(['b', 'a']);
    expect(r.picks[0]!.lane).toBe('agent');
    expect(r.nearMisses.map((n) => n.nodeId)).toEqual(['d']);
    expect(r.gap).toBeNull();
  });

  it('stays inside the budget; the first pick is cut to fit, later ones are skipped', () => {
    const r = pickJournalEntries(
      [c('a', 'context', 0.9, 'a'.repeat(500)), c('b', 'context', 0.8, 'b'.repeat(500))],
      { cutoff: 0.7, budgetChars: 300 },
    );
    expect(r.picks.map((p) => p.nodeId)).toEqual(['a']);
    expect(r.picks[0]!.text.length).toBeLessThanOrEqual(300);
    expect(r.chars).toBe(r.picks[0]!.text.length);
  });

  it('sends the best passage of a long body, the whole of a short one', () => {
    const long = 'L '.repeat(1000);
    const r = pickJournalEntries([c('a', 'context', 0.9, long), c('b', 'context', 0.8)], {
      cutoff: 0.7,
      budgetChars: 3000,
      passages: new Map([['a', 'the matching passage']]),
    });
    expect(r.picks[0]).toMatchObject({ nodeId: 'a', text: 'the matching passage', passage: true });
    expect(r.picks[1]).toMatchObject({ nodeId: 'b', text: 'b body', passage: false });
  });

  it('journal_recall scores pick the agent lane (best score first, own budget); user lane stays on similarity', () => {
    const r = pickJournalEntries(
      [
        c('ctx', 'context', 0.8),
        c('r1', 'expectation', 0.2), // weak by similarity, strong by Jev
        c('r2', 'lesson', 0.95), // strong by similarity, below Jev's cut
        c('r3', 'expectation', 0.1),
        c('r4', 'expectation', 0.3), // unscored: stays out
      ],
      {
        cutoff: 0.7,
        budgetChars: 3000,
        agentScores: {
          scores: new Map([
            ['r1', 2.4],
            ['r2', 0.9],
            ['r3', 2.9],
          ]),
          threshold: 1.5,
        },
      },
    );
    expect(r.picks.map((p) => p.nodeId)).toEqual(['r3', 'r1', 'ctx']);
    expect(r.picks[0]).toMatchObject({ lane: 'agent', score: 2.9 });
    expect(r.picks.find((p) => p.nodeId === 'ctx')!.score).toBeUndefined();
  });

  it('a rule Jev did not score (failed group) falls back to similarity, not lost', () => {
    const r = pickJournalEntries([c('a', 'lesson', 0.95), c('b', 'lesson', 0.95)], {
      cutoff: 0.7,
      budgetChars: 3000,
      agentScores: { scores: new Map([['a', 2.5]]), threshold: 1.5 },
    });
    expect(r.picks.map((p) => p.nodeId).sort()).toEqual(['a', 'b']);
    expect(r.picks.find((p) => p.nodeId === 'b')!.score).toBeUndefined();
  });

  it('tier 1 overflow joins tier 2; entries shown in tier 1 never do', () => {
    const r = pickJournalEntries([c('shown', 'preference', 0.9), c('over', 'preference', 0.9)], {
      cutoff: 0.7,
      budgetChars: 3000,
      alwaysOn: new Set(['shown']),
    });
    expect(r.picks.map((p) => p.nodeId)).toEqual(['over']);
  });

  it('a budget too small for a real pick sends nothing (no stub, no ellipsis-only gap)', () => {
    const r = pickJournalEntries(
      [c('g', 'gap', 0.9, 'q'.repeat(400)), c('a', 'context', 0.9, 'a'.repeat(400))],
      { cutoff: 0.7, budgetChars: 0 },
    );
    expect(r.gap).toBeNull();
    expect(r.picks).toHaveLength(0);
    const r2 = pickJournalEntries([c('a', 'context', 0.9, 'a'.repeat(400))], {
      cutoff: 0.7,
      budgetChars: 40,
    });
    expect(r2.picks).toHaveLength(0);
  });

  it('whole only when the full body went out', () => {
    const r = pickJournalEntries(
      [c('a', 'context', 0.9, 'a'.repeat(500)), c('b', 'context', 0.8)],
      { cutoff: 0.7, budgetChars: 300 },
    );
    expect(r.picks.map((p) => [p.nodeId, p.whole])).toEqual([['a', false]]);
    const r2 = pickJournalEntries([c('b', 'context', 0.8)], { cutoff: 0.7, budgetChars: 300 });
    expect(r2.picks[0]!.whole).toBe(true);
  });

  it('adds at most one open, matching gap; resolved or weak gaps never', () => {
    const r = pickJournalEntries(
      [
        c('g1', 'gap', 0.95, 'resolved q', { status: 'resolved' }),
        c('g2', 'gap', 0.8, 'open q', { status: 'open' }),
        c('g3', 'gap', 0.75, 'other q'),
        c('g4', 'gap', 0.4, 'weak q'),
      ],
      { cutoff: 0.7, budgetChars: 3000 },
    );
    expect(r.gap?.nodeId).toBe('g2');
    expect(r.picks).toHaveLength(0);
  });
});

describe('renderRelevantJournalBlock', () => {
  const pick = (
    kind: string,
    lane: 'user' | 'agent',
    text: string,
    agentSlug: string | null = null,
  ) => ({
    nodeId: text,
    kind,
    lane,
    agentSlug,
    similarity: 0.8,
    text,
    passage: false,
    whole: true,
  });

  it('renders user entries, working notes with attribution, and the gap', () => {
    const block = renderRelevantJournalBlock(
      {
        picks: [
          pick('context', 'user', 'On leave in May'),
          pick('lesson', 'agent', 'Cite the SOP', 'pages'),
        ],
        gap: pick('gap', 'agent', 'Which site is primary?'),
      },
      'assistant',
    );
    expect(block).toMatch(/^# From the Journal \(relevant to this message\)/);
    expect(block).toContain('## About the user\n- (context) On leave in May');
    expect(block).toContain('- (lesson) Cite the SOP _(learned by pages)_');
    expect(block).toContain('## Open question');
    expect(block).toContain('journal_resolve_gap');
  });

  it('is empty when nothing was picked', () => {
    expect(renderRelevantJournalBlock({ picks: [], gap: null })).toBe('');
  });
});
