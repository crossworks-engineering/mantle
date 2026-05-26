import { describe, expect, it } from 'vitest';
import {
  arePersonNamesDistinct,
  isLikelyDifferentPerson,
  tokenizePersonName,
} from './person-names';

describe('tokenizePersonName', () => {
  it('splits a normal full name', () => {
    expect(tokenizePersonName('Don Schoeman')).toEqual(['Don', 'Schoeman']);
  });

  it('drops a leading honorific', () => {
    expect(tokenizePersonName('Mr J Schoeman')).toEqual(['J', 'Schoeman']);
    expect(tokenizePersonName('Dr. Mary Jones')).toEqual(['Mary', 'Jones']);
    expect(tokenizePersonName('Prof Doe')).toEqual(['Doe']);
  });

  it('keeps single-token names intact', () => {
    expect(tokenizePersonName('Modular')).toEqual(['Modular']);
    expect(tokenizePersonName('  Schoeman  ')).toEqual(['Schoeman']);
  });

  it('collapses internal whitespace', () => {
    expect(tokenizePersonName('Don   Schoeman')).toEqual(['Don', 'Schoeman']);
  });
});

describe('arePersonNamesDistinct', () => {
  it('the motivating case: siblings with the same surname are distinct', () => {
    expect(arePersonNamesDistinct('Don Schoeman', 'Jason Schoeman')).toBe(true);
    expect(arePersonNamesDistinct('Jonathan Schoeman', 'Don Schoeman')).toBe(true);
  });

  it('different surnames are NOT this rule\'s concern (let normal logic decide)', () => {
    expect(arePersonNamesDistinct('Don Schoeman', 'Don Smith')).toBe(false);
  });

  it('initials are ambiguous — could be the same person', () => {
    expect(arePersonNamesDistinct('J Schoeman', 'Don Schoeman')).toBe(false);
    expect(arePersonNamesDistinct('J. Schoeman', 'Don Schoeman')).toBe(false);
    expect(arePersonNamesDistinct('Don Schoeman', 'D Schoeman')).toBe(false);
  });

  it('honorifics + initials are also ambiguous', () => {
    expect(arePersonNamesDistinct('Mr J Schoeman', 'Don Schoeman')).toBe(false);
    expect(arePersonNamesDistinct('Mr J Schoeman', 'Jason Schoeman')).toBe(false);
  });

  it('prefix overlap (nickname/long-form) leans "same"', () => {
    expect(arePersonNamesDistinct('Don Schoeman', 'Donald Schoeman')).toBe(false);
    expect(arePersonNamesDistinct('John Smith', 'Johnathan Smith')).toBe(false);
    expect(arePersonNamesDistinct('Sam Brown', 'Samantha Brown')).toBe(false);
  });

  it('single-token name on either side is ambiguous', () => {
    expect(arePersonNamesDistinct('Don', 'Don Schoeman')).toBe(false);
    expect(arePersonNamesDistinct('Schoeman', 'Don Schoeman')).toBe(false);
    expect(arePersonNamesDistinct('Modular', 'Jane Modular')).toBe(false);
  });

  it('identical full names are not "distinct"', () => {
    expect(arePersonNamesDistinct('Don Schoeman', 'don schoeman')).toBe(false);
  });

  it('three-token names compare on first + last', () => {
    // Mary Jane vs Mary Anne — same given (Mary) → not distinct by this rule.
    expect(arePersonNamesDistinct('Mary Jane Smith', 'Mary Anne Smith')).toBe(false);
    // Different first given, same surname → distinct.
    expect(arePersonNamesDistinct('Mary Jane Smith', 'Anne Marie Smith')).toBe(true);
  });
});

describe('isLikelyDifferentPerson', () => {
  it('refuses to merge when every known name on the existing entity is a different Schoeman', () => {
    expect(
      isLikelyDifferentPerson(
        { name: 'Don Schoeman', kind: 'person' },
        { name: 'Jason Schoeman', aliases: ['Jonathan Schoeman'] },
      ),
    ).toBe(true);
  });

  it('lets the merge through when ANY known name is ambiguous', () => {
    // The candidate is already an alias on the existing entity (initials).
    expect(
      isLikelyDifferentPerson(
        { name: 'Don Schoeman', kind: 'person' },
        { name: 'Jason Schoeman', aliases: ['J Schoeman'] },
      ),
    ).toBe(false);
  });

  it('never fires for non-person kinds', () => {
    expect(
      isLikelyDifferentPerson(
        { name: 'Don Co', kind: 'org' },
        { name: 'Jason Co', aliases: [] },
      ),
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
        { name: 'Don Schoeman', kind: 'person' },
        { name: 'Jason Schoeman', aliases: [] },
      ),
    ).toBe(true);
  });
});
