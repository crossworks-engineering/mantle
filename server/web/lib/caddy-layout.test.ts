import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The front door is ONE release-owned Caddyfile plus shape files, wired into
 * compose, the image and the updater. Each piece is a plain file with no
 * type-checker over it, so this pins the wiring: a rename or a dropped mount
 * here shows up in CI instead of as a box with no routing after a roll.
 */
const ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('infra/caddy layout', () => {
  it('ships one Caddyfile that imports the shape by env and the conf.d drop-ins', () => {
    const caddy = read('infra/caddy/Caddyfile');
    expect(caddy).toContain('import /etc/caddy/shapes/{$MANTLE_CADDY_SHAPE:same-origin}.caddy');
    expect(caddy).toContain('import /etc/caddy/conf.d/*.caddy');
    expect(caddy).toContain('max_size {$MANTLE_MAX_BODY_SIZE:1GB}');
    expect(caddy).not.toContain('max_size 100MB');
    expect(existsSync(join(ROOT, 'infra/caddy/Caddyfile.same-origin'))).toBe(false);
  });

  it('ships both shapes, each routing to the server app', () => {
    for (const shape of ['same-origin', 'split']) {
      const body = read(`infra/caddy/shapes/${shape}.caddy`);
      expect(body).toContain('reverse_proxy web:3000');
      expect(body).not.toMatch(/^\s*\{\$MANTLE_SITE_ADDRESS/m); // no site blocks inside a shape
    }
    expect(read('infra/caddy/shapes/same-origin.caddy')).toContain('reverse_proxy client-web:3000');
  });

  it('compose mounts shapes + conf.d and passes the shape and body-cap env to caddy', () => {
    const compose = read('docker-compose.yml');
    expect(compose).toContain('./infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro');
    expect(compose).toContain('./infra/caddy/shapes:/etc/caddy/shapes:ro');
    expect(compose).toContain('./infra/caddy/conf.d:/etc/caddy/conf.d:ro');
    expect(compose).toContain('MANTLE_CADDY_SHAPE: ${MANTLE_CADDY_SHAPE:-same-origin}');
    expect(compose).toContain('MANTLE_MAX_BODY_SIZE: ${MANTLE_MAX_BODY_SIZE:-1GB}');
  });

  it('the image embeds the Caddyfile and shapes where the updater reads them', () => {
    const docker = read('Dockerfile');
    expect(docker).toContain('COPY infra/caddy/Caddyfile /app/release/Caddyfile');
    expect(docker).toContain('COPY infra/caddy/shapes /app/release/caddy-shapes');
    const updater = read('infra/updater/updater.sh');
    expect(updater).toContain('refresh_caddy');
    expect(updater).toContain('/app/release/caddy-shapes/$shape.caddy');
    expect(updater).toContain('"caddy_refresh":"%s"');
    expect(updater).toContain('--force-recreate');
  });

  it('keeps sign-in codes out of the access log and out of Referer headers (audit B12)', () => {
    const caddy = read('infra/caddy/Caddyfile');
    // The log filters the uri and drops the Referer; the JSON shape stays.
    expect(caddy).toMatch(/format filter \{\s*wrap json/);
    expect(caddy).toContain('request>headers>Referer delete');
    const m = /request>uri regexp "([^"]+)" "([^"]+)"/.exec(caddy);
    expect(m).toBeTruthy();
    // Apply the filter as Caddy does (Go's ReplaceAllString with ${n}).
    const re = new RegExp(m![1]!, 'g');
    const redact = (uri: string) =>
      uri.replace(re, (_all, a?: string, b?: string) => `${a ?? ''}${b ?? ''}REDACTED`);
    expect(m![2]).toBe('${1}${2}REDACTED');
    const secret = 'AbCdEfGhJkMnPqRs';
    for (const [uri, want] of [
      [`/client-signin?code=${secret}`, '/client-signin?code=REDACTED'],
      [`/invite?x=1&code=${secret}&y=2`, '/invite?x=1&code=REDACTED&y=2'],
      [`/api/auth/invite/${secret}`, '/api/auth/invite/REDACTED'],
      ['/api/auth/invite/accept', '/api/auth/invite/accept'],
      ['/api/files/files/abc?raw=1', '/api/files/files/abc?raw=1'],
      ['/api/x?barcode=1', '/api/x?barcode=1'],
    ] as const) {
      expect(redact(uri), uri).toBe(want);
      expect(redact(uri).includes(secret), uri).toBe(false);
    }
    // No-referrer on the link pages, in the main site and the split vhost.
    const pages = caddy.match(
      /@signin_pages path \/client-signin \/client-signin\/\* \/invite \/invite\/\*/g,
    );
    expect(pages?.length).toBe(2);
    expect(caddy.match(/header @signin_pages >Referrer-Policy no-referrer/g)?.length).toBe(2);
  });

  it('box-local drop-ins are gitignored (public repo)', () => {
    expect(read('.gitignore')).toContain('infra/caddy/conf.d/*.caddy');
  });
});
