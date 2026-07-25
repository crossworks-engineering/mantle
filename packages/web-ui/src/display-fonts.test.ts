import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOGO_FONT,
  DEFAULT_TITLE_FONT,
  fontPrepaintScript,
  resolveFontVars,
} from './display-fonts';

/**
 * resolveFontVars is the single projection behind every server-side appearance
 * stamp (share/print `appearanceStamp` + the client's /env.js). Its contract:
 * defaults and unknown keys resolve to NOTHING — the emitting side must be
 * able to treat "no key" as "emit no statement" so the var() fallbacks win.
 */
describe('resolveFontVars', () => {
  it('returns nothing for unset / default / unknown keys', () => {
    expect(resolveFontVars(undefined, undefined)).toEqual({});
    expect(resolveFontVars(null, null)).toEqual({});
    expect(resolveFontVars(DEFAULT_LOGO_FONT, DEFAULT_TITLE_FONT)).toEqual({});
    expect(resolveFontVars('no-such-font', 'also-not-a-font')).toEqual({});
  });

  it('resolves a real non-default key to its family + fallback', () => {
    const { wordmark } = resolveFontVars('bungee-shade', undefined);
    expect(wordmark).toBe('"Bungee Shade", sans-serif');
  });

  it('resolves each slot independently', () => {
    const vars = resolveFontVars(undefined, 'capriola');
    expect(vars.wordmark).toBeUndefined();
    expect(vars.pageTitle).toBe('"Capriola", sans-serif');
  });

  it("maps the 'sans' title choice onto the UI font var (non-default for the title slot)", () => {
    // 'sans' IS the default logo font's counterpart case: default for neither
    // slot here — as a title it's the default (skipped); as a logo it's a real
    // choice resolving to the app font var.
    expect(resolveFontVars('sans', undefined).wordmark).toBe(
      'var(--font-sans, ui-sans-serif, sans-serif)',
    );
    expect(resolveFontVars(undefined, 'sans').pageTitle).toBeUndefined();
  });
});

describe('fontPrepaintScript', () => {
  it('yields to a server-side stamp via the __MANTLE_APPEARANCE__ flag', () => {
    // The guard is load-bearing: without it a stale localStorage copy repaints
    // over the authoritative /env.js stamp. Pin its presence and position
    // (before any localStorage read).
    const script = fontPrepaintScript();
    const guard = script.indexOf('if(window.__MANTLE_APPEARANCE__)return;');
    const firstRead = script.indexOf('localStorage.getItem');
    expect(guard).toBeGreaterThan(-1);
    expect(firstRead).toBeGreaterThan(guard);
  });
});
