import { describe, expect, it } from 'vitest';
import {
  projectAppOpens,
  projectAppPins,
  projectNavFavorites,
  projectSounds,
} from './profile-projections';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('projectAppPins', () => {
  it('keeps UUIDs in order, lowercased and deduped', () => {
    expect(projectAppPins([id(2), id(1).toUpperCase(), id(2), 'x'])).toEqual([id(2), id(1)]);
  });
  it('is undefined when nothing survives', () => {
    expect(projectAppPins(['x'])).toBeUndefined();
    expect(projectAppPins('x')).toBeUndefined();
  });
});

describe('projectNavFavorites', () => {
  it('keeps in-app hrefs only', () => {
    expect(
      projectNavFavorites(['/notes', '//evil.example', 'https://x.test', '/notes', ' /tasks ']),
    ).toEqual(['/notes', '/tasks']);
  });
});

describe('projectAppOpens', () => {
  it('drops malformed counters and orders by most recent', () => {
    const out = projectAppOpens({
      [id(1)]: { n: 3, at: '2026-09-01T00:00:00.000Z' },
      [id(2)]: { n: 1, at: '2026-09-20T00:00:00.000Z' },
      [id(3)]: { n: 0, at: '2026-09-20T00:00:00.000Z' },
      bad: { n: 5, at: '2026-09-20T00:00:00.000Z' },
    })!;
    expect(Object.keys(out)).toEqual([id(2), id(1)]);
  });
});

describe('projectSounds', () => {
  it('is unset for anything but an object', () => {
    expect(projectSounds(undefined)).toBeUndefined();
    expect(projectSounds('on')).toBeUndefined();
    expect(projectSounds([true, 1])).toBeUndefined();
  });

  it('keeps a stored choice, clamps the volume, defaults what is missing', () => {
    expect(projectSounds({ enabled: false, volume: 0.3 })).toEqual({ enabled: false, volume: 0.3 });
    expect(projectSounds({ enabled: true, volume: 4 })).toEqual({ enabled: true, volume: 1 });
    expect(projectSounds({ volume: -1 })).toEqual({ enabled: true, volume: 0 });
    expect(projectSounds({ enabled: 'no', volume: Number.NaN })).toEqual({
      enabled: true,
      volume: 0.7,
    });
  });
});
