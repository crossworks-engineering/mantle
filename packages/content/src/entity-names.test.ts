import { describe, expect, it } from 'vitest';
import {
  findPersonInitialsMatch,
  isDocumentTitleMention,
  isNumberedWorkLabel,
  personNameParts,
  personNamesCompatible,
  personNamesConflict,
  planPersonInitialMerges,
  titleKey,
} from './entity-names';

describe('titleKey', () => {
  it('drops a catalogue number, bracket tags and the extension', () => {
    expect(titleKey('0519 - Believing with the Heart [chs519]')).toBe('believing with the heart');
    expect(titleKey('0519 - Believing with the Heart [chs519].pdf')).toBe(
      'believing with the heart',
    );
    expect(titleKey('Believing with the Heart')).toBe('believing with the heart');
  });
  it('drops a catalogue number range and a numbered label in parentheses', () => {
    expect(titleKey('0039-40 - Heaven and Hell [chs39-40]')).toBe('heaven and hell');
    expect(titleKey('Amazing Grace (Sermon #1279)')).toBe(
      titleKey('1279 - Amazing Grace [chs1279]'),
    );
    expect(titleKey('Grace (and Peace)')).toBe('grace and peace');
  });
  it('folds curly apostrophes and dashes', () => {
    expect(titleKey('The Soul’s Best Food')).toBe(titleKey("The Soul's Best Food"));
    expect(titleKey('Christ—The Power and Wisdom of God')).toBe(
      'christ the power and wisdom of god',
    );
  });
  it('keeps a title that is only a number word', () => {
    expect(titleKey('2400 - Number 2400; Or [chs2400]')).toBe('number 2400 or');
  });
});

describe('isNumberedWorkLabel', () => {
  it('matches labels that only number a work', () => {
    for (const s of ['Sermon #2268', 'Sermon No. 12', 'Chapter 3', 'Vol. II', 'Episode 12'])
      expect(isNumberedWorkLabel(s)).toBe(true);
  });
  it('does not match real names', () => {
    for (const s of ['Sermon on the Mount', 'Project 2026 Launch', 'Part-time job', 'Apollo 11'])
      expect(isNumberedWorkLabel(s)).toBe(false);
  });
});

describe('isDocumentTitleMention', () => {
  const file = { type: 'file', title: '0519 - Believing with the Heart [chs519]' };
  it("drops a file's own title as a project or event", () => {
    expect(isDocumentTitleMention({ name: 'Believing with the Heart', kind: 'event' }, file)).toBe(
      true,
    );
    expect(
      isDocumentTitleMention({ name: 'Believing With The Heart', kind: 'project' }, file),
    ).toBe(true);
    expect(isDocumentTitleMention({ name: 'Sermon #519', kind: 'project' }, file)).toBe(true);
  });
  it('keeps other kinds, other names and non-document nodes', () => {
    expect(isDocumentTitleMention({ name: 'Believing with the Heart', kind: 'org' }, file)).toBe(
      false,
    );
    expect(isDocumentTitleMention({ name: 'Harvest Festival', kind: 'event' }, file)).toBe(false);
    const note = { type: 'note', title: 'Kitchen renovation' };
    expect(isDocumentTitleMention({ name: 'Kitchen renovation', kind: 'project' }, note)).toBe(
      false,
    );
  });
});

describe('personNameParts', () => {
  it('splits initials and drops titles and suffixes', () => {
    expect(personNameParts('C.H. Spurgeon')).toEqual({ given: ['c', 'h'], surname: 'spurgeon' });
    expect(personNameParts('Rev. C. H. Spurgeon')).toEqual({
      given: ['c', 'h'],
      surname: 'spurgeon',
    });
    expect(personNameParts('Pastor T. Spurgeon')).toEqual({ given: ['t'], surname: 'spurgeon' });
    expect(personNameParts('John Smith Jr.')).toEqual({ given: ['john'], surname: 'smith' });
  });
  it('returns null without a given name', () => {
    expect(personNameParts('Mrs. Spurgeon')).toBeNull();
    expect(personNameParts('Mr. Spurgeon')).toBeNull();
    expect(personNameParts('Spurgeon')).toBeNull();
  });
});

describe('personNamesCompatible', () => {
  it('joins initials to full given names on the same surname', () => {
    expect(personNamesCompatible('C.H. Spurgeon', 'Charles Spurgeon')).toBe(true);
    expect(personNamesCompatible('C.H. Spurgeon', 'Charles Haddon Spurgeon')).toBe(true);
    expect(personNamesCompatible('Charles Spurgeon', 'Charles Haddon Spurgeon')).toBe(true);
    expect(personNamesCompatible('Charles H. Spurgeon', 'C. Spurgeon')).toBe(true);
  });
  it('never joins different first names', () => {
    expect(personNamesCompatible('Thomas Spurgeon', 'C.H. Spurgeon')).toBe(false);
    expect(personNamesCompatible('James Spurgeon', 'John Spurgeon')).toBe(false);
    expect(personNamesCompatible('Charlie Smith', 'Charles Smith')).toBe(false);
    expect(personNamesCompatible('Charles H. Spurgeon', 'Charles T. Spurgeon')).toBe(false);
  });
  it('never joins on a surname alone', () => {
    expect(personNamesCompatible('Mrs. Spurgeon', 'Charles Spurgeon')).toBe(false);
    expect(personNamesCompatible('Spurgeon', 'C.H. Spurgeon')).toBe(false);
    expect(personNamesCompatible('Charles Spurgeon', 'Charles Wesley')).toBe(false);
  });
});

describe('personNamesConflict', () => {
  it('flags a different first given name on the same surname', () => {
    expect(personNamesConflict('C.H. Spurgeon', 'J. A. Spurgeon')).toBe(true);
    expect(personNamesConflict('C.H. Spurgeon', 'Pastor T. Spurgeon')).toBe(true);
  });
  it('keeps agreeing, given-less and other-surname aliases', () => {
    expect(personNamesConflict('C.H. Spurgeon', 'Rev. C. H. Spurgeon')).toBe(false);
    expect(personNamesConflict('C.H. Spurgeon', 'Mr. Spurgeon')).toBe(false);
    expect(personNamesConflict('C.H. Spurgeon', 'The Prince of Preachers')).toBe(false);
  });
});

describe('findPersonInitialsMatch', () => {
  const people = [
    { id: 'charles', name: 'Charles Spurgeon' },
    { id: 'thomas', name: 'Thomas Spurgeon' },
    { id: 'mrs', name: 'Mrs. Spurgeon' },
  ];
  it('resolves to the single agreeing person', () => {
    expect(findPersonInitialsMatch(people, 'C.H. Spurgeon')?.id).toBe('charles');
  });
  it('refuses an ambiguous initial', () => {
    const js = [
      { id: 'john', name: 'John Smith' },
      { id: 'jane', name: 'Jane Smith' },
    ];
    expect(findPersonInitialsMatch(js, 'J. Smith')).toBeNull();
    expect(findPersonInitialsMatch(people, 'Spurgeon')).toBeNull();
  });
});

describe('planPersonInitialMerges', () => {
  it('groups agreeing names and leaves distinct relatives alone', () => {
    const { groups, ambiguous } = planPersonInitialMerges([
      { id: '1', name: 'C.H. Spurgeon' },
      { id: '2', name: 'Charles Spurgeon' },
      { id: '3', name: 'Thomas Spurgeon' },
      { id: '4', name: 'James Spurgeon' },
      { id: '5', name: 'John Spurgeon' },
      { id: '6', name: 'Mrs. Spurgeon' },
    ]);
    expect(groups.map((g) => g.map((p) => p.id).sort())).toEqual([['1', '2']]);
    expect(ambiguous).toEqual([]);
  });
  it('refuses a group whose members disagree', () => {
    const { groups, ambiguous } = planPersonInitialMerges([
      { id: 'j', name: 'J. Spurgeon' },
      { id: 'john', name: 'John Spurgeon' },
      { id: 'james', name: 'James Spurgeon' },
    ]);
    expect(groups).toEqual([]);
    expect(ambiguous).toHaveLength(1);
  });
});
