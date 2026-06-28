import { describe, expect, it } from 'vitest';
import { renderIdentityBlock, type IdentityEntry } from './identity-context';

const e = (
  body: string,
  category: string | null = null,
  mood: string | null = null,
): IdentityEntry => ({ body, category, mood });

/** Count rendered bullet lines (each entry is one `- ` line). */
const bulletCount = (block: string) => block.split('\n').filter((l) => l.startsWith('- ')).length;

describe('renderIdentityBlock', () => {
  it('returns an empty string when there are no entries', () => {
    expect(renderIdentityBlock([])).toBe('');
  });

  it('returns an empty string when every entry has an empty body', () => {
    expect(renderIdentityBlock([e(''), e('   '), e('\n')])).toBe('');
  });

  it('renders the header, a category heading, the bullet, and inline mood', () => {
    const block = renderIdentityBlock([e('I value honesty.', 'identity', 'reflective')]);
    expect(block).toContain('# About the user (Journal)');
    expect(block).toContain('## Identity');
    expect(block).toContain('- I value honesty. _(felt: reflective)_');
  });

  it('omits the mood tag when there is no mood', () => {
    const block = renderIdentityBlock([e('I run a small business.', 'work')]);
    expect(block).toContain('- I run a small business.');
    expect(block).not.toContain('_(felt:');
  });

  it('groups by the canonical category order (identity before work)', () => {
    const block = renderIdentityBlock([e('builder', 'work'), e('father', 'identity')]);
    expect(block.indexOf('## Identity')).toBeLessThan(block.indexOf('## Work'));
  });

  it('buckets unknown / blank categories into a trailing "Other"', () => {
    const block = renderIdentityBlock([
      e('knows aluminium', 'hobbies'),
      e('a work thing', 'work'),
    ]);
    expect(block).toContain('## Other');
    expect(block.indexOf('## Work')).toBeLessThan(block.indexOf('## Other'));
  });

  it('caps each category at 6 entries', () => {
    const many = Array.from({ length: 10 }, (_, i) => e(`work note ${i}`, 'work'));
    const block = renderIdentityBlock(many);
    expect(bulletCount(block)).toBe(6);
  });

  it('caps the total at 30 entries across all categories', () => {
    const cats = ['identity', 'work', 'family', 'relationships', 'faith', 'health', 'emotion', 'goal'];
    // 8 categories × 6 each = 48 eligible; total cap should clamp to 30.
    const many: IdentityEntry[] = [];
    for (const c of cats) for (let i = 0; i < 6; i++) many.push(e(`${c} note ${i}`, c));
    const block = renderIdentityBlock(many);
    expect(bulletCount(block)).toBe(30);
  });

  it('collapses whitespace and truncates a very long body with an ellipsis', () => {
    const block = renderIdentityBlock([e('word '.repeat(200).trim(), 'reflection')]);
    const bullet = block.split('\n').find((l) => l.startsWith('- '))!;
    expect(bullet).toContain('…');
    // 280-char cap (+ "- " prefix); generously bounded, never the full 1000 chars.
    expect(bullet.length).toBeLessThanOrEqual(2 + 280);
    expect(bullet).not.toContain('  '); // no double spaces left
  });
});
