import { describe, expect, it } from 'vitest';
import {
  arePersonNamesDistinct,
  isLikelyDifferentPerson,
  tokenizePersonName,
} from './person-names';

describe('tokenizePersonName', () => {
  it('splits a normal full name', () => {
    expect(tokenizePersonName('Don Botha')).toEqual(['Don', 'Botha']);
  });

  it('drops a leading honorific', () => {
    expect(tokenizePersonName('Mr J Botha')).toEqual(['J', 'Botha']);
    expect(tokenizePersonName('Dr. Mary Jones')).toEqual(['Mary', 'Jones']);
    expect(tokenizePersonName('Prof Doe')).toEqual(['Doe']);
  });

  it('keeps single-token names intact', () => {
    expect(tokenizePersonName('Modular')).toEqual(['Modular']);
    expect(tokenizePersonName('  Botha  ')).toEqual(['Botha']);
  });

  it('collapses internal whitespace', () => {
    expect(tokenizePersonName('Don   Botha')).toEqual(['Don', 'Botha']);
  });
});

describe('arePersonNamesDistinct', () => {
  it('the motivating case: siblings with the same surname are distinct', () => {
    expect(arePersonNamesDistinct('Don Botha', 'Jason Botha')).toBe(true);
    expect(arePersonNamesDistinct('Jonathan Botha', 'Don Botha')).toBe(true);
  });

  it("different surnames are NOT this rule's concern (let normal logic decide)", () => {
    expect(arePersonNamesDistinct('Don Botha', 'Don Smith')).toBe(false);
  });

  it('initials are ambiguous — could be the same person', () => {
    expect(arePersonNamesDistinct('J Botha', 'Don Botha')).toBe(false);
    expect(arePersonNamesDistinct('J. Botha', 'Don Botha')).toBe(false);
    expect(arePersonNamesDistinct('Don Botha', 'D Botha')).toBe(false);
  });

  it('honorifics + initials are also ambiguous', () => {
    expect(arePersonNamesDistinct('Mr J Botha', 'Don Botha')).toBe(false);
    expect(arePersonNamesDistinct('Mr J Botha', 'Jason Botha')).toBe(false);
  });

  it('prefix overlap (nickname/long-form) leans "same"', () => {
    expect(arePersonNamesDistinct('Don Botha', 'Donald Botha')).toBe(false);
    expect(arePersonNamesDistinct('John Smith', 'Johnathan Smith')).toBe(false);
    expect(arePersonNamesDistinct('Sam Brown', 'Samantha Brown')).toBe(false);
  });

  it('single-token name on either side is ambiguous', () => {
    expect(arePersonNamesDistinct('Don', 'Don Botha')).toBe(false);
    expect(arePersonNamesDistinct('Botha', 'Don Botha')).toBe(false);
    expect(arePersonNamesDistinct('Modular', 'Jane Modular')).toBe(false);
  });

  it('identical full names are not "distinct"', () => {
    expect(arePersonNamesDistinct('Don Botha', 'don botha')).toBe(false);
  });

  it('three-token names compare on first + last', () => {
    // Mary Jane vs Mary Anne — same given (Mary) → not distinct by this rule.
    expect(arePersonNamesDistinct('Mary Jane Smith', 'Mary Anne Smith')).toBe(false);
    // Different first given, same surname → distinct.
    expect(arePersonNamesDistinct('Mary Jane Smith', 'Anne Marie Smith')).toBe(true);
  });
});

describe('isLikelyDifferentPerson', () => {
  it('refuses to merge when every known name on the existing entity is a different Botha', () => {
    expect(
      isLikelyDifferentPerson(
        { name: 'Don Botha', kind: 'person' },
        { name: 'Jason Botha', aliases: ['Jonathan Botha'] },
      ),
    ).toBe(true);
  });

  it('lets the merge through when ANY known name is ambiguous', () => {
    // The candidate is already an alias on the existing entity (initials).
    expect(
      isLikelyDifferentPerson(
        { name: 'Don Botha', kind: 'person' },
        { name: 'Jason Botha', aliases: ['J Botha'] },
      ),
    ).toBe(false);
  });

  it('never fires for non-person kinds', () => {
    expect(
      isLikelyDifferentPerson({ name: 'Don Co', kind: 'org' }, { name: 'Jason Co', aliases: [] }),
    ).toBe(false);
    expect(
      isLikelyDifferentPerson(
        { name: 'Don Place', kind: 'place' },
        { name: 'Jason Place', aliases: [] },
      ),
    ).toBe(false);
  });

  it('handles an empty aliases array gracefully', () => {
    expect(
      isLikelyDifferentPerson(
        { name: 'Don Botha', kind: 'person' },
        { name: 'Jason Botha', aliases: [] },
      ),
    ).toBe(true);
  });
});
