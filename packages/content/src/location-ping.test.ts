import { describe, expect, it } from 'vitest';
import { sanitizeLocationPing, buildLocationContextLine } from './location-ping';

describe('sanitizeLocationPing', () => {
  it('accepts a full ping and keeps every valid field', () => {
    const p = sanitizeLocationPing({
      latitude: -33.9249,
      longitude: 18.4241,
      timestamp: '2026-06-20T14:30:00.000Z',
      accuracy: 5,
      altitude: 52,
      altitudeAccuracy: 3,
      speed: 2.1,
      heading: 180,
      battery: 0.84,
      source: 'gps',
      isMock: false,
    });
    expect(p).toMatchObject({
      latitude: -33.9249,
      longitude: 18.4241,
      timestamp: '2026-06-20T14:30:00.000Z',
      accuracy: 5,
      altitude: 52,
      altitudeAccuracy: 3,
      speed: 2.1,
      heading: 180,
      battery: 0.84,
      source: 'gps',
      isMock: false,
    });
  });

  it('returns null without usable coordinates', () => {
    expect(sanitizeLocationPing(null)).toBeNull();
    expect(sanitizeLocationPing({})).toBeNull();
    expect(sanitizeLocationPing({ latitude: 1 })).toBeNull();
    expect(sanitizeLocationPing('nope')).toBeNull();
    expect(sanitizeLocationPing([1, 2])).toBeNull();
  });

  it('rejects out-of-range coordinates', () => {
    expect(sanitizeLocationPing({ latitude: 91, longitude: 0 })).toBeNull();
    expect(sanitizeLocationPing({ latitude: 0, longitude: 181 })).toBeNull();
  });

  it('accepts snake_case + alternate keys from the wire', () => {
    const p = sanitizeLocationPing({ lat: 10, lng: 20, horizontal_accuracy: 8, is_mock: true });
    expect(p?.latitude).toBe(10);
    expect(p?.longitude).toBe(20);
    expect(p?.accuracy).toBe(8);
    expect(p?.isMock).toBe(true);
  });

  it('normalises a 0..100 battery to a 0..1 fraction', () => {
    expect(sanitizeLocationPing({ lat: 0, lon: 0, battery: 84 })?.battery).toBeCloseTo(0.84, 5);
    expect(sanitizeLocationPing({ lat: 0, lon: 0, battery: 0.42 })?.battery).toBeCloseTo(0.42, 5);
  });

  it('drops malformed optionals instead of failing the whole ping', () => {
    const p = sanitizeLocationPing({
      lat: 0,
      lon: 0,
      accuracy: 'bad',
      heading: 999,
      speed: -3,
      source: 'satellite',
    });
    expect(p).not.toBeNull();
    expect(p?.accuracy).toBeUndefined();
    expect(p?.heading).toBeUndefined();
    expect(p?.speed).toBeUndefined();
    expect(p?.source).toBeUndefined();
  });

  it('defaults a missing/garbled timestamp to a valid ISO instant', () => {
    const p = sanitizeLocationPing({ lat: 0, lon: 0 });
    expect(p?.timestamp).toBeDefined();
    expect(Number.isNaN(Date.parse(p!.timestamp))).toBe(false);
  });

  it('accepts an epoch-ms timestamp', () => {
    const p = sanitizeLocationPing({ lat: 0, lon: 0, timestamp: 1782950400000 });
    expect(p?.timestamp).toBe(new Date(1782950400000).toISOString());
  });
});

describe('buildLocationContextLine', () => {
  it('returns empty string for a null ping', () => {
    expect(buildLocationContextLine(null)).toBe('');
  });

  it('renders coordinates, accuracy and a tool hint', () => {
    const line = buildLocationContextLine({
      latitude: -33.9249,
      longitude: 18.4241,
      timestamp: '2026-06-20T14:30:00.000Z',
      accuracy: 5,
    });
    expect(line).toContain('Current location: -33.92490, 18.42410');
    expect(line).toContain('±5m');
    expect(line).toContain('location_nearby');
  });

  it('flags a mock fix and low accuracy', () => {
    const line = buildLocationContextLine({
      latitude: 0,
      longitude: 0,
      timestamp: '2026-06-20T14:30:00.000Z',
      accuracy: 500,
      isMock: true,
    });
    expect(line).toMatch(/MOCK/i);
    expect(line).toMatch(/low accuracy/i);
  });

  it('only mentions movement when actually moving', () => {
    const still = buildLocationContextLine({
      latitude: 0,
      longitude: 0,
      timestamp: '2026-06-20T14:30:00.000Z',
      speed: 0.1,
    });
    expect(still).not.toMatch(/moving/);
    const moving = buildLocationContextLine({
      latitude: 0,
      longitude: 0,
      timestamp: '2026-06-20T14:30:00.000Z',
      speed: 3,
      heading: 90,
    });
    expect(moving).toMatch(/moving 3.0 m\/s heading 90/);
  });
});
