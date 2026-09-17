import { describe, expect, it } from 'vitest';
import {
  renderIdentityBlock,
  renderPurposeBlock,
  renderWorkingNotesBlock,
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
