import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_FONT_SIZE,
  DEFAULT_LOGO_FONT,
  DEFAULT_PROSE_FONT,
  DEFAULT_TITLE_FONT,
  DEFAULT_UI_FONT,
  FONT_LIBRARY,
  FONT_SHELVES,
  FONT_SIZES,
  displayFontFaceCss,
  fontByKey,
  fontFamilyValue,
  resolveFontSize,
  resolveFontVars,
} from './display-fonts';
import { resolveAppearanceAttrs, type BrainAppearance } from './appearance';

/** A fully-default appearance row; individual tests override one field, so
 *  adding a field to BrainAppearance can't silently skip a case. */
const DEFAULTS: BrainAppearance = {
  colorTheme: null,
  fontLogo: null,
  fontTitle: null,
  fontUi: null,
  fontProse: null,
  fontSize: null,
  fontLogoSize: null,
  fontTitleSize: null,
  fontProseSize: null,
  avatarStyle: null,
  avatarTint: null,
  backgrounds: null,
};

/**
 * resolveFontVars is the projection behind the server-rendered <html>
 * appearance (see appearance.ts). Its contract: defaults and unknown keys
 * resolve to NOTHING — "default" is the absence of the var, so the elements'
 * var() fallbacks win.
 */
describe('resolveFontVars', () => {
  it('returns nothing for unset / default / unknown keys', () => {
    expect(resolveFontVars(undefined, undefined, undefined, undefined)).toEqual({});
    expect(resolveFontVars(null, null, null, null)).toEqual({});
    expect(
      resolveFontVars(DEFAULT_LOGO_FONT, DEFAULT_TITLE_FONT, DEFAULT_UI_FONT, DEFAULT_PROSE_FONT),
    ).toEqual({});
    expect(resolveFontVars('no-such-font', 'also-not-a-font', 'nope', 'nor-this')).toEqual({});
  });

  it('resolves a real non-default key to its family + fallback', () => {
    expect(resolveFontVars('playfair', null, null, null).wordmark).toBe('"Playfair", serif');
  });

  it('resolves each slot independently', () => {
    const vars = resolveFontVars(null, 'fraunces', null, 'inconsolata');
    expect(vars.wordmark).toBeUndefined();
    expect(vars.pageTitle).toBe('"Fraunces", serif');
    expect(vars.ui).toBeUndefined();
    expect(vars.prose).toBe('"Inconsolata", monospace');
  });

  it("maps 'inherit' onto the interface font var, and it IS the default for two slots", () => {
    expect(resolveFontVars('inherit', null, null, null).wordmark).toBe(
      'var(--font-sans, ui-sans-serif, sans-serif)',
    );
    expect(resolveFontVars(null, 'inherit', null, null).pageTitle).toBeUndefined();
    expect(resolveFontVars(null, null, null, 'inherit').prose).toBeUndefined();
  });

  // 'sans' was the old name for "follow the interface font" and was the shipped
  // default for the peer name. A brain that stored it explicitly must keep the
  // behaviour it chose rather than acquiring a concrete face.
  it("keeps the legacy 'sans' key meaning what it used to mean", () => {
    expect(fontByKey('sans')?.key).toBe('inherit');
    expect(resolveFontVars('sans', null, null, null).wordmark).toBe(
      'var(--font-sans, ui-sans-serif, sans-serif)',
    );
  });
});

/**
 * resolveAppearanceAttrs feeds every <html> render of the brain's appearance
 * (client root layout + the server htmlPage). Contract: "default" means the
 * attribute is ABSENT — the appearance of a fresh brain is an empty object,
 * and an unknown key must never surface as attribute/provider state.
 */
describe('resolveAppearanceAttrs', () => {
  it('null / all-default input resolves to no attributes', () => {
    expect(resolveAppearanceAttrs(null)).toEqual({ fontVars: {} });
    expect(resolveAppearanceAttrs({ ...DEFAULTS, colorTheme: 'clean-slate' })).toEqual({
      fontVars: {},
    });
  });

  it('carries a non-default theme and resolved fonts, attributes + vars in lockstep', () => {
    const attrs = resolveAppearanceAttrs({
      ...DEFAULTS,
      colorTheme: 'amethyst-haze',
      fontLogo: 'fredoka',
      fontTitle: 'playfair',
      fontProse: 'fraunces',
    });
    expect(attrs.colorTheme).toBe('amethyst-haze');
    expect(attrs.fontLogo).toBe('fredoka');
    expect(attrs.fontTitle).toBe('playfair');
    expect(attrs.fontProse).toBe('fraunces');
    expect(attrs.fontVars).toEqual({
      wordmark: '"Fredoka", sans-serif',
      pageTitle: '"Playfair", serif',
      prose: '"Fraunces", serif',
    });
  });

  it('drops unknown font keys entirely — no attribute without a resolved var', () => {
    const attrs = resolveAppearanceAttrs({
      ...DEFAULTS,
      fontLogo: 'ghost-font',
      fontTitle: 'playfair',
    });
    expect(attrs.fontLogo).toBeUndefined();
    expect(attrs.fontVars.wordmark).toBeUndefined();
    expect(attrs.fontTitle).toBe('playfair');
  });

  // Sizes travel as attributes only — app.css owns the multipliers. Medium is
  // the absence of the attribute, and an unknown size must not reach the
  // document at all (there is no registry to fall through, and a bad value
  // would rescale the whole interface).
  it('carries non-default sizes and drops medium + garbage', () => {
    const attrs = resolveAppearanceAttrs({
      ...DEFAULTS,
      fontSize: 'xsmall',
      fontLogoSize: 'large',
      fontTitleSize: 'medium',
      fontProseSize: 'enormous',
    });
    expect(attrs.fontSize).toBe('xsmall');
    expect(attrs.fontLogoSize).toBe('large');
    expect(attrs.fontTitleSize).toBeUndefined();
    expect(attrs.fontProseSize).toBeUndefined();
  });
});

describe('font sizes', () => {
  it('resolves the four known sizes and nothing else', () => {
    for (const s of FONT_SIZES) expect(resolveFontSize(s.id)).toBe(s.id);
    expect(resolveFontSize('enormous')).toBe(DEFAULT_FONT_SIZE);
    expect(resolveFontSize(null)).toBe(DEFAULT_FONT_SIZE);
  });

  // app.css keys its rules off these exact ids. A size added here without a
  // matching rule would be storable, selectable, and do nothing.
  it('every non-default size has a rule in app.css', () => {
    const css = readFileSync(fileURLToPath(new URL('../styles/app.css', import.meta.url)), 'utf8');
    for (const s of FONT_SIZES) {
      if (s.id === DEFAULT_FONT_SIZE) continue;
      for (const attr of ['data-font-size', 'data-logo-size', 'data-title-size', 'data-prose-size'])
        expect(css, `${attr}='${s.id}' has no rule`).toContain(`${attr}='${s.id}'`);
    }
  });
});

/**
 * The registry names files by hand and TWO apps serve them from their own
 * `public/` — so a font can be listed with no file behind it (the modal offers
 * a face that 404s and silently falls back), or a file can outlive the entry
 * that pointed at it (dead weight in both images, nobody notices). Neither
 * shows up in a typecheck. Both directions are asserted here, per app.
 */
const APPS = ['client', 'server'] as const;
const publicDir = (app: string) =>
  fileURLToPath(new URL(`../../../${app}/web/public`, import.meta.url));

/** Every file the registry claims, upright and italic alike. */
const FILES = FONT_LIBRARY.flatMap((f) => [f.file, f.italicFile].filter(Boolean) as string[]);

describe('the font library', () => {
  it('has unique keys', () => {
    // One lookup map is built from the list, so a duplicate key would make a
    // stored choice resolve to whichever entry happened to come last.
    const keys = FONT_LIBRARY.map((f) => f.key);
    expect(new Set(keys).size, 'duplicate font key').toBe(keys.length);
  });

  it('files every face under a known shelf', () => {
    const shelves = FONT_SHELVES.map((s) => s.id);
    for (const f of FONT_LIBRARY) expect(shelves, f.key).toContain(f.shelf);
  });

  it('has a default for each of the four slots, and each is in the registry', () => {
    for (const key of [
      DEFAULT_UI_FONT,
      DEFAULT_LOGO_FONT,
      DEFAULT_TITLE_FONT,
      DEFAULT_PROSE_FONT,
    ]) {
      expect(fontByKey(key), `${key} is a default but not in the registry`).toBeTruthy();
    }
  });

  it('keeps Inter out of the library files', () => {
    // Inter is the always-loaded next/font face, served from public/Inter. It
    // must not ALSO ship as a library file, or it is in the image twice.
    expect(fontByKey(DEFAULT_UI_FONT)!.file).toBeNull();
    expect(FILES.some((f) => f.includes('inter'))).toBe(false);
  });

  it('declares a weight range on every face with a file', () => {
    // These are all VARIABLE fonts. Without `font-weight` in @font-face the
    // browser takes the file as a single 400 and SYNTHESISES bold — smeared
    // headings and buttons everywhere.
    const css = displayFontFaceCss();
    for (const f of FONT_LIBRARY) {
      if (!f.file || !f.family) continue;
      expect(f.weight, `${f.key} would render synthesised bold`).toBeTruthy();
      expect(css, `${f.key} weight range missing from @font-face`).toContain(
        `font-weight:${f.weight};`,
      );
    }
  });

  // The library's whole premise. Two axes is the floor, and the ranges are read
  // out of each file by scripts/fonts-import.mjs rather than typed, so a row
  // that fails this was hand-edited.
  it('gives every shipped face at least two axes', () => {
    for (const f of FONT_LIBRARY) {
      if (!f.file) continue;
      const count = [f.weight, f.stretch, f.style].filter(Boolean).length + (f.axes?.length ?? 0);
      expect(count, `${f.key} is not a multi-axis variable face`).toBeGreaterThanOrEqual(2);
    }
  });

  // A slnt axis IS the italic. Shipping a separate italic file alongside one
  // would put two faces on the same family at the same style, and which one
  // wins is not something to leave to declaration order.
  it('never pairs a slant axis with a separate italic file', () => {
    for (const f of FONT_LIBRARY) {
      if (f.style) expect(f.italicFile, `${f.key} has both slnt and an italic file`).toBeFalsy();
    }
  });

  it('emits a second @font-face for every real italic', () => {
    const css = displayFontFaceCss();
    for (const f of FONT_LIBRARY) {
      if (!f.italicFile) continue;
      expect(css, `${f.key} italic missing`).toContain(
        `src:url("${f.italicFile}") format("woff2");font-display:swap;font-style:italic;`,
      );
    }
  });

  it('previews Inter through the base var, not the overridable one', () => {
    // The modal previews each row in its own face. 'inter' must therefore NOT
    // resolve through --font-sans — that is the var the interface choice
    // overrides, so the Inter row would render in whatever face is selected.
    expect(fontFamilyValue(DEFAULT_UI_FONT)).toBe(
      'var(--font-sans-base, ui-sans-serif, sans-serif)',
    );
    // ...while 'inherit' deliberately does follow the interface font.
    expect(fontFamilyValue('inherit')).toBe('var(--font-sans, ui-sans-serif, sans-serif)');
  });

  for (const app of APPS) {
    it(`${app}/web ships a file for every registry entry`, () => {
      const missing = FILES.filter((f) => !existsSync(`${publicDir(app)}${f}`));
      expect(missing, `listed in the font registry but absent`).toEqual([]);
    });

    it(`${app}/web ships no library face the registry dropped`, () => {
      const listed = new Set(FILES.map((f) => f.split('/').pop()!));
      const orphans = readdirSync(`${publicDir(app)}/fonts/library`)
        .filter((n) => /\.(ttf|otf|woff2?)$/.test(n))
        .filter((n) => !listed.has(n));
      expect(orphans, 'delete these, or add the registry entry back').toEqual([]);
    });

    // Self-hosted OFL faces: shipping the bytes without the terms is the one
    // way this library could actually get us in trouble.
    it(`${app}/web ships a licence for every family`, () => {
      const licences = new Set(readdirSync(`${publicDir(app)}/fonts/library/licenses`));
      const missing = FONT_LIBRARY.filter((f) => f.file).filter(
        (f) => !licences.has(`${f.key}.txt`),
      );
      expect(
        missing.map((f) => f.key),
        'no licence file beside the face',
      ).toEqual([]);
    });
  }

  it('declares each face with the format its file actually is', () => {
    const css = displayFontFaceCss();
    for (const f of FILES) {
      const want = f.endsWith('.woff2') ? 'woff2' : 'truetype';
      expect(css, `${f} declared with the wrong format()`).toContain(
        `url("${f}") format("${want}")`,
      );
    }
  });
});

/**
 * Both apps carry their own copy of the font payload, on purpose: client/web
 * serves it through `next start`, server/web through its own static layer
 * (server/static.ts) for the public /s and /print surfaces. Each origin needs
 * the bytes, so the duplication is load-bearing and stays.
 *
 * What must NOT happen is the two drifting. Update a face in one app and forget
 * the other and nothing breaks loudly — the share page just quietly renders a
 * different font from the app that authored it, on a surface nobody is looking
 * at. Content hashes make that impossible to land.
 *
 * Adding or replacing a face means mirroring it into BOTH public dirs, which
 * `scripts/fonts-import.mjs` does for you; see server/web/CLAUDE.md.
 */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string, rel: string) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(abs, entry.name), next);
      else
        out[next] = createHash('sha256')
          .update(readFileSync(join(abs, entry.name)))
          .digest('hex');
    }
  };
  walk(dir, '');
  return out;
}

describe('the two apps serve the same font payload', () => {
  // Everything duplicated between them: the variable-font library and its
  // licences, and the Inter UI face.
  for (const root of ['fonts', 'Inter'] as const) {
    it(`public/${root} is byte-identical in client/web and server/web`, () => {
      const client = fingerprint(`${publicDir('client')}/${root}`);
      const server = fingerprint(`${publicDir('server')}/${root}`);

      expect(
        Object.keys(server).sort(),
        `public/${root}: one app has files the other does not`,
      ).toEqual(Object.keys(client).sort());

      const differing = Object.keys(client).filter((f) => client[f] !== server[f]);
      expect(
        differing,
        `public/${root}: same filename, different bytes — mirror the change`,
      ).toEqual([]);
    });
  }
});
