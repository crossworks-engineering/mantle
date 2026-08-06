import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_LOGO_FONT,
  DEFAULT_TITLE_FONT,
  DEFAULT_UI_FONT,
  DISPLAY_FONTS,
  UI_FONTS,
  displayFontFaceCss,
  fontFamilyValue,
  resolveFontVars,
} from './display-fonts';

/** Both registries ship out of the same library dir and the same @font-face
 *  block, so every file-level invariant below covers the pair. */
const ALL_FONTS = [...DISPLAY_FONTS, ...UI_FONTS];
import { resolveAppearanceAttrs } from './appearance';

/**
 * resolveFontVars is the projection behind the server-rendered <html>
 * appearance (see appearance.ts). Its contract: defaults and unknown keys
 * resolve to NOTHING — "default" is the absence of the var, so the elements'
 * var() fallbacks win.
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

  it("maps the 'sans' logo choice onto the UI font var; as a title it IS the default", () => {
    expect(resolveFontVars('sans', undefined).wordmark).toBe(
      'var(--font-sans, ui-sans-serif, sans-serif)',
    );
    expect(resolveFontVars(undefined, 'sans').pageTitle).toBeUndefined();
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
    expect(
      resolveAppearanceAttrs({
        colorTheme: 'clean-slate',
        fontLogo: null,
        fontTitle: null,
        avatarStyle: null,
        avatarTint: null,
        fontUi: null,
        fontSize: null,
      }),
    ).toEqual({ fontVars: {} });
  });

  it('carries a non-default theme and resolved fonts, attributes + vars in lockstep', () => {
    const attrs = resolveAppearanceAttrs({
      colorTheme: 'amethyst-haze',
      fontLogo: 'bungee-shade',
      fontTitle: 'capriola',
      avatarStyle: null,
      avatarTint: null,
      fontUi: null,
      fontSize: null,
    });
    expect(attrs.colorTheme).toBe('amethyst-haze');
    expect(attrs.fontLogo).toBe('bungee-shade');
    expect(attrs.fontTitle).toBe('capriola');
    expect(attrs.fontVars).toEqual({
      wordmark: '"Bungee Shade", sans-serif',
      pageTitle: '"Capriola", sans-serif',
    });
  });

  it('drops unknown font keys entirely — no attribute without a resolved var', () => {
    const attrs = resolveAppearanceAttrs({
      colorTheme: null,
      fontLogo: 'ghost-font',
      fontTitle: 'capriola',
      avatarStyle: null,
      avatarTint: null,
      fontUi: null,
      fontSize: null,
    });
    expect(attrs.fontLogo).toBeUndefined();
    expect(attrs.fontVars.wordmark).toBeUndefined();
    expect(attrs.fontTitle).toBe('capriola');
  });
});

/**
 * The registry names files by hand and TWO apps serve them from their own
 * `public/` — so a font can be listed with no file behind it (picker offers a
 * face that 404s and silently falls back), or a file can outlive the entry that
 * pointed at it (dead weight in both images, nobody notices). Neither shows up
 * in a typecheck. Both directions are asserted here, per app.
 */
const APPS = ['client', 'server'] as const;
const publicDir = (app: string) =>
  fileURLToPath(new URL(`../../../${app}/web/public`, import.meta.url));

/**
 * The UI font is the face the whole app is read in, so it carries invariants
 * the decorative faces do not.
 */
describe('UI fonts', () => {
  it('shares no key with the display registry', () => {
    // One lookup map is built from both lists, so a duplicate key would make a
    // stored choice resolve to the WRONG face depending on list order.
    const keys = ALL_FONTS.map((f) => f.key);
    expect(new Set(keys).size, 'duplicate font key across the two registries').toBe(keys.length);
  });

  it('declares a weight range on every face with a file', () => {
    // These are all VARIABLE fonts. Without `font-weight` in @font-face the
    // browser takes the file as a single 400 and SYNTHESISES bold — smeared
    // headings and buttons everywhere, on the one font that is always on screen.
    for (const f of UI_FONTS) {
      if (!f.file) continue;
      expect(f.weight, `${f.key} would render synthesised bold`).toBeTruthy();
    }
    const css = displayFontFaceCss();
    for (const f of UI_FONTS) {
      if (!f.file || !f.family) continue;
      expect(css, `${f.key} weight range missing from @font-face`).toContain(
        `font-weight:${f.weight};`,
      );
    }
  });

  it('has a default that is the built-in face, carrying no file', () => {
    const def = UI_FONTS.find((f) => f.key === DEFAULT_UI_FONT);
    expect(def, 'the default UI font must be in the registry').toBeTruthy();
    // Inter is the always-loaded next/font face — it must not ALSO be shipped
    // as a library file, or every visitor pays for it twice.
    expect(def!.file).toBeNull();
  });

  it('groups every face under a known category', () => {
    for (const f of UI_FONTS) {
      expect(['sans', 'mono', 'character'], f.key).toContain(f.category);
    }
  });

  // The picker previews each row in its own face. 'inter' must therefore NOT
  // resolve through --font-sans — that is the var the interface choice
  // overrides, so the Inter row would render in whatever face is selected.
  it('previews Inter through the base var, not the overridable one', () => {
    expect(fontFamilyValue(DEFAULT_UI_FONT)).toBe(
      'var(--font-sans-base, ui-sans-serif, sans-serif)',
    );
    // ...while the DISPLAY default 'sans' deliberately does follow the UI font.
    expect(fontFamilyValue('sans')).toBe('var(--font-sans, ui-sans-serif, sans-serif)');
  });

  it('resolves as the --font-sans override, and the default resolves to nothing', () => {
    expect(resolveFontVars(undefined, undefined, DEFAULT_UI_FONT).ui).toBeUndefined();
    expect(resolveFontVars(undefined, undefined, 'not-a-font').ui).toBeUndefined();
    expect(resolveFontVars(undefined, undefined, 'geist').ui).toBe('"Geist", sans-serif');
  });
});

describe('display-font files', () => {
  for (const app of APPS) {
    it(`${app}/web ships a file for every registry entry`, () => {
      const missing = ALL_FONTS.filter((f) => f.file).filter(
        (f) => !existsSync(`${publicDir(app)}${f.file}`),
      );
      expect(
        missing.map((f) => f.file),
        `listed in a font registry but absent`,
      ).toEqual([]);
    });

    it(`${app}/web ships no library face the registry dropped`, () => {
      const listed = new Set(
        ALL_FONTS.map((f) => f.file?.split('/').pop()).filter(Boolean) as string[],
      );
      const orphans = readdirSync(`${publicDir(app)}/fonts/library`)
        .filter((n) => /\.(ttf|otf|woff2?)$/.test(n))
        .filter((n) => !listed.has(n));
      expect(orphans, 'delete these, or add the registry entry back').toEqual([]);
    });
  }

  it('declares each face with the format its file actually is', () => {
    const css = displayFontFaceCss();
    for (const f of ALL_FONTS) {
      if (!f.file || !f.family) continue;
      const want = f.file.endsWith('.woff2') ? 'woff2' : 'truetype';
      expect(css, `${f.key} declared with the wrong format()`).toContain(
        `url("${f.file}") format("${want}")`,
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
 * Adding or replacing a face means mirroring it into BOTH public dirs; see
 * `scripts/fonts-to-woff2.mjs` and server/web/CLAUDE.md.
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
  // Everything duplicated between them: the display library and its licenses,
  // the Bukhari wordmark, and the Inter UI face.
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
