import { describe, expect, it } from 'vitest';
import {
  aliasToAdd,
  findOrgVariant,
  parseClassifierDecision,
  planFileVersionSupersede,
  resolveCostCap,
  type VersionSibling,
} from './rules';

describe('parseClassifierDecision', () => {
  it('reads a plain or fenced JSON decision', () => {
    expect(parseClassifierDecision('{"decision":"UPDATE","target_index":2}')).toEqual({
      decision: 'UPDATE',
      target_index: 2,
    });
    expect(
      parseClassifierDecision('```json\n{"decision":"NOOP","target_index":1}\n```').decision,
    ).toBe('NOOP');
  });
  it('falls back to ADD on garbage or an unknown verb', () => {
    expect(parseClassifierDecision('not json')).toEqual({ decision: 'ADD', target_index: null });
    expect(parseClassifierDecision('{"decision":"MERGE","target_index":1}')).toEqual({
      decision: 'ADD',
      target_index: null,
    });
  });
});

describe('resolveCostCap', () => {
  it('treats 0, negatives and non-numbers as "no cap"', () => {
    expect(resolveCostCap(0)).toBeNull();
    expect(resolveCostCap(-5)).toBeNull();
    expect(resolveCostCap('12')).toBeNull();
    expect(resolveCostCap(undefined)).toBeNull();
    expect(resolveCostCap(2500)).toBe(2500);
  });
});

describe('aliasToAdd', () => {
  const acme = { name: 'Acme', aliases: ['ACME Inc'] };
  it('records a genuinely new spelling', () => {
    expect(aliasToAdd(acme, 'Acme Corporation')).toBe('Acme Corporation');
  });
  it('skips the canonical name (any case) and existing aliases', () => {
    expect(aliasToAdd(acme, 'acme')).toBeNull();
    expect(aliasToAdd(acme, 'ACME Inc')).toBeNull();
  });
});

describe('findOrgVariant', () => {
  const norm = (n: string) =>
    n
      .replace(/\s*\((pty)\)\s*ltd$/i, '')
      .trim()
      .toLowerCase() || null;
  const orgs = [{ name: 'Acme' }, { name: 'Globex (Pty) Ltd' }];
  it('matches a legal-form variant of an existing org', () => {
    expect(findOrgVariant(orgs, 'Acme (Pty) Ltd', norm)?.name).toBe('Acme');
    expect(findOrgVariant(orgs, 'globex', norm)?.name).toBe('Globex (Pty) Ltd');
  });
  it('ignores an exact same name and unrelated names', () => {
    expect(findOrgVariant(orgs, 'Acme', norm)).toBeNull();
    expect(findOrgVariant(orgs, 'Initech', norm)).toBeNull();
  });
});

describe('planFileVersionSupersede', () => {
  const DEMOTED = 0.4;
  const sib = (id: string, day: number, extra: Partial<VersionSibling> = {}): VersionSibling => ({
    id,
    createdAt: new Date(Date.UTC(2026, 0, day)),
    salience: 1,
    supersededBy: null,
    supersededReason: null,
    ...extra,
  });

  it('demotes every older pristine sibling under the newest', () => {
    const plan = planFileVersionSupersede([sib('a', 1), sib('c', 3), sib('b', 2)], DEMOTED);
    expect(plan.headId).toBe('c');
    expect(plan.demoteIds.sort()).toEqual(['a', 'b']);
    expect(plan.restoreHead).toBe(false);
  });

  it('is idempotent: siblings already demoted under this head are left alone', () => {
    const plan = planFileVersionSupersede(
      [
        sib('a', 1, { salience: DEMOTED, supersededBy: 'c', supersededReason: 'version' }),
        sib('c', 3),
      ],
      DEMOTED,
    );
    expect(plan.demoteIds).toEqual([]);
  });

  it('re-points a sibling demoted under an older head', () => {
    const plan = planFileVersionSupersede(
      [
        sib('a', 1, { salience: DEMOTED, supersededBy: 'b', supersededReason: 'version' }),
        sib('b', 2, { salience: DEMOTED, supersededBy: 'c', supersededReason: 'version' }),
        sib('c', 3),
      ],
      DEMOTED,
    );
    expect(plan.demoteIds).toEqual(['a']);
  });

  it('never touches a manually superseded sibling', () => {
    const plan = planFileVersionSupersede(
      [sib('a', 1, { supersededReason: 'corrected' }), sib('b', 2), sib('c', 3)],
      DEMOTED,
    );
    expect(plan.demoteIds).toEqual(['b']);
  });

  it('stands down entirely when the newest was manually superseded', () => {
    const plan = planFileVersionSupersede(
      [sib('a', 1), sib('c', 3, { supersededReason: 'corrected' })],
      DEMOTED,
    );
    expect(plan).toEqual({ headId: null, demoteIds: [], restoreHead: false });
  });

  it('restores a head that a prior pass or a rename left demoted', () => {
    const plan = planFileVersionSupersede(
      [
        sib('a', 1),
        sib('c', 3, { salience: DEMOTED, supersededBy: 'a', supersededReason: 'version' }),
      ],
      DEMOTED,
    );
    expect(plan.headId).toBe('c');
    expect(plan.restoreHead).toBe(true);
    expect(plan.demoteIds).toEqual(['a']);
  });

  it('handles an empty or single-member family', () => {
    expect(planFileVersionSupersede([], DEMOTED)).toEqual({
      headId: null,
      demoteIds: [],
      restoreHead: false,
    });
    expect(planFileVersionSupersede([sib('a', 1)], DEMOTED)).toEqual({
      headId: 'a',
      demoteIds: [],
      restoreHead: false,
    });
  });
});
