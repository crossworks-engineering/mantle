import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAppFrameCsp } from '@mantle/share-ui/app-frame-html';
import { buildCanvasFrameCsp } from '@mantle/share-ui/canvas-frame-html';

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

  it('same-origin sends every runtime bundle the server serves to the server', () => {
    // A runtime bundle is loaded by a sandboxed frame (a canvas, a mini app,
    // a share island) that sends no cookies: on the client app it meets a
    // login redirect and the frame stays blank. Every /<x>-runtime/* prefix
    // static.ts serves must be a server path in the same-origin shape.
    const served = [
      ...read('server/web/server/static.ts').matchAll(/'\/([a-z-]+-runtime)\/\*'/g),
    ].map((m) => m[1]);
    expect(new Set(served)).toEqual(new Set(['app-runtime', 'canvas-runtime', 'share-runtime']));
    const line =
      read('infra/caddy/shapes/same-origin.caddy').match(/^@server path (.+)$/m)?.[1] ?? '';
    for (const prefix of served) expect(line.split(' ')).toContain(`/${prefix}/*`);
  });

  it('same-origin sends every path a sandboxed frame loads from the box to the server', () => {
    // The frame's origin is 'null': a script, style or font it loads from the
    // box is a cross-origin fetch with no cookies. Only the server answers
    // those CORS-open, so every box path in a frame CSP must be a server path.
    const ORIGIN = 'https://box.example';
    const paths = new Set<string>();
    for (const csp of [buildCanvasFrameCsp(ORIGIN, []), buildAppFrameCsp(ORIGIN)]) {
      for (const m of csp.matchAll(/https:\/\/box\.example(\/[^\s;]+\/)/g)) paths.add(`${m[1]}*`);
    }
    expect(paths.size).toBeGreaterThan(0);
    const line =
      read('infra/caddy/shapes/same-origin.caddy').match(/^@server path (.+)$/m)?.[1] ?? '';
    for (const p of paths) expect(line.split(' ')).toContain(p);
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

  it('pins HTTPS in the browser (HSTS) on both site blocks, on TLS responses only', () => {
    // Where port 80 is closed at the cloud edge a bare hostname tries plain
    // http first and hangs before the redirect; a browser that has seen the
    // header goes straight to https from then on. Both site blocks send it,
    // only on TLS responses, for a year, this host only.
    const caddy = read('infra/caddy/Caddyfile');
    expect(caddy.match(/^\s*@https protocol https$/gm)?.length).toBe(2);
    const hsts = caddy.match(/^\s*header @https Strict-Transport-Security "([^"]+)"$/gm) ?? [];
    expect(hsts.length).toBe(2);
    for (const line of hsts) {
      const value = /"([^"]+)"/.exec(line)![1]!;
      expect(value).toMatch(/^max-age=\d+$/); // no includeSubDomains, no preload
      expect(Number(/\d+/.exec(value)![0])).toBeGreaterThanOrEqual(31536000);
    }
  });

  it('box-local drop-ins are gitignored (public repo)', () => {
    expect(read('.gitignore')).toContain('infra/caddy/conf.d/*.caddy');
  });
});
