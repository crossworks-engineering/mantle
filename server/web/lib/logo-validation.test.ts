import { describe, expect, it } from 'vitest';
import { sniffType, SVG_ACTIVE_RE } from './logo-validation';
import { projectLogoKey, projectLogoType, logoVersion } from '@mantle/content';

/**
 * The brand-logo upload's validation is defense for a PUBLIC serve route
 * (/api/appearance/logo): the type comes from the BYTES, never the browser's
 * claim, and an SVG with active content is rejected outright — CSP on the
 * serve side is the second layer, not the only one.
 */
describe('sniffType', () => {
  it('identifies the three raster types by magic numbers', () => {
    expect(sniffType(Buffer.from('\x89PNG\r\n\x1a\n0000', 'binary'))).toBe('image/png');
    expect(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe('image/jpeg');
    expect(
      sniffType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])),
    ).toBe('image/webp');
  });

  it('identifies svg through xml decl, comments and doctype', () => {
    expect(sniffType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(
      'image/svg+xml',
    );
    expect(
      sniffType(
        Buffer.from(
          '<?xml version="1.0"?>\n<!-- brand -->\n<!DOCTYPE svg>\n<svg viewBox="0 0 1 1"/>',
        ),
      ),
    ).toBe('image/svg+xml');
  });

  it('rejects everything else — a claimed type never matters', () => {
    expect(sniffType(Buffer.from('GIF89a...'))).toBeNull(); // gif deliberately unsupported
    expect(sniffType(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    expect(sniffType(Buffer.from('plain text'))).toBeNull();
    expect(sniffType(Buffer.alloc(0))).toBeNull();
  });
});

describe('SVG_ACTIVE_RE', () => {
  it('trips on every active-content shape', () => {
    for (const bad of [
      '<svg><script>alert(1)</script></svg>',
      '<svg onload="alert(1)"/>',
      '<svg><a href="javascript:alert(1)">x</a></svg>',
      '<svg><foreignObject><body/></foreignObject></svg>',
      '<svg><use href="http://evil.example/x.svg#p"/></svg>',
    ]) {
      expect(SVG_ACTIVE_RE.test(bad), bad).toBe(true);
    }
  });

  it('passes a plain vector', () => {
    expect(
      SVG_ACTIVE_RE.test(
        '<svg viewBox="0 0 100 30"><path d="M0 0h100v30H0z" fill="currentColor"/><text x="4" y="20">Acme</text></svg>',
      ),
    ).toBe(false);
  });
});

describe('logo prefs projections', () => {
  const key = `attachments/aa/bb/${'a'.repeat(64)}`;

  it('accepts only the exact content-addressed key shape', () => {
    expect(projectLogoKey(key)).toBe(key);
    expect(projectLogoKey('attachments/../../etc/passwd')).toBeUndefined();
    expect(projectLogoKey('files/x')).toBeUndefined();
    expect(projectLogoKey('')).toBeUndefined(); // the jsonb-merge "clear" write
    expect(projectLogoKey(42)).toBeUndefined();
  });

  it('accepts only the serve allowlist for the type', () => {
    expect(projectLogoType('image/svg+xml')).toBe('image/svg+xml');
    expect(projectLogoType('text/html')).toBeUndefined();
    expect(projectLogoType('')).toBeUndefined();
  });

  it('derives the cache-busting version from the key sha', () => {
    expect(logoVersion(key)).toBe('aaaaaaaa');
    expect(logoVersion(undefined)).toBeNull();
    expect(logoVersion('')).toBeNull();
  });
});
