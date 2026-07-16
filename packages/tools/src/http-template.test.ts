/**
 * Contract tests for http-tool templating. The invariants that matter:
 *
 *   1. Legacy handlers (bare url + method, no templates) behave exactly
 *      as before: non-GET sends the whole input as a JSON body.
 *   2. `{param}` is URL-encoded in the URL, raw in query/headers, and
 *      JSON-encoded in body templates.
 *   3. `{{secret:…}}` refs resolve ONLY when written by the tool author —
 *      a model passing a ref string as an input value gets a literal.
 *   4. `scrubSecrets` strips plaintexts (and their URL-encoded forms)
 *      from anything that could leave the dispatcher.
 */

import { describe, expect, it } from 'vitest';
import {
  buildHttpRequest,
  collectParamNames,
  collectSecretRefs,
  scrubSecrets,
  type HttpHandler,
} from './http-template';

const secrets = new Map([['mapbox/default', 'pk.SUPER-SECRET-123']]);

describe('legacy behavior', () => {
  it('POSTs the whole input as JSON when no templates are used', () => {
    const h: HttpHandler = { kind: 'http', url: 'https://api.example.com/hook' };
    const req = buildHttpRequest(h, { a: 1, b: 'two' }, new Map());
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/hook');
    expect(JSON.parse(req.body!)).toEqual({ a: 1, b: 'two' });
    expect(req.headers['content-type']).toBe('application/json');
  });

  it('GET sends leftover input as query params, no body', () => {
    const h: HttpHandler = { kind: 'http', url: 'https://api.example.com/search', method: 'GET' };
    const req = buildHttpRequest(h, { q: 'cape town', limit: 5 }, new Map());
    expect(req.body).toBeNull();
    expect(req.url).toBe('https://api.example.com/search?q=cape%20town&limit=5');
  });
});

describe('{param} substitution', () => {
  it('URL-encodes path params in the URL', () => {
    const h: HttpHandler = {
      kind: 'http',
      url: 'https://api.example.com/places/{query}.json',
      method: 'GET',
    };
    const req = buildHttpRequest(h, { query: 'São Paulo/BR' }, new Map());
    expect(req.url).toBe('https://api.example.com/places/S%C3%A3o%20Paulo%2FBR.json');
  });

  it('consumed params do not spill into query/body', () => {
    const h: HttpHandler = {
      kind: 'http',
      url: 'https://api.example.com/items/{id}',
      method: 'GET',
      query: { detail: '{level}' },
    };
    const req = buildHttpRequest(h, { id: '42', level: 'full', extra: 'x' }, new Map());
    expect(req.url).toBe('https://api.example.com/items/42?detail=full&extra=x');
  });

  it('JSON-encodes params in body templates (strings arrive quoted)', () => {
    const h: HttpHandler = {
      kind: 'http',
      url: 'https://api.example.com/route',
      method: 'POST',
      body: '{"from": {origin}, "max_km": {radius}, "opts": {opts}}',
    };
    const req = buildHttpRequest(
      h,
      { origin: 'A "quoted" place', radius: 25, opts: { toll: false } },
      new Map(),
    );
    expect(JSON.parse(req.body!)).toEqual({
      from: 'A "quoted" place',
      max_km: 25,
      opts: { toll: false },
    });
  });

  it('leaves unfilled placeholders intact', () => {
    const h: HttpHandler = { kind: 'http', url: 'https://x.test/{missing}', method: 'GET' };
    const req = buildHttpRequest(h, {}, new Map());
    expect(req.url).toBe('https://x.test/{missing}');
  });

  it('collects param names across url, query, headers, and body', () => {
    const h: HttpHandler = {
      kind: 'http',
      url: 'https://x.test/{a}',
      query: { q: '{b}' },
      headers: { 'x-c': '{c}' },
      body: '{"d": {d}}',
    };
    expect(collectParamNames(h).sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('{{secret:…}} resolution', () => {
  it('resolves refs in headers and query values', () => {
    const h: HttpHandler = {
      kind: 'http',
      url: 'https://api.mapbox.com/geocode/{q}.json',
      method: 'GET',
      query: { access_token: '{{secret:mapbox/default}}' },
      headers: { authorization: 'Bearer {{secret:mapbox/default}}' },
    };
    expect(collectSecretRefs(h)).toEqual([{ service: 'mapbox', label: 'default' }]);
    const req = buildHttpRequest(h, { q: 'home' }, secrets);
    expect(req.url).toContain('access_token=pk.SUPER-SECRET-123');
    expect(req.headers.authorization).toBe('Bearer pk.SUPER-SECRET-123');
  });

  it('does NOT resolve a ref smuggled in via input values', () => {
    const h: HttpHandler = {
      kind: 'http',
      url: 'https://api.example.com/echo',
      method: 'POST',
      body: '{"msg": {msg}}',
    };
    const req = buildHttpRequest(h, { msg: '{{secret:mapbox/default}}' }, secrets);
    expect(req.body).not.toContain('pk.SUPER-SECRET-123');
    expect(JSON.parse(req.body!)).toEqual({ msg: '{{secret:mapbox/default}}' });
  });

  it('does NOT leak a secret when input forges the internal token', () => {
    // The author template carries one secret; a hostile model tries to echo it
    // back by passing the (formerly predictable) substitution token as input.
    const h: HttpHandler = {
      kind: 'http',
      url: 'https://api.example.com/q',
      method: 'GET',
      query: { token: '{{secret:mapbox/default}}' },
    };
    const forged = '\u0000S0\u0000';
    const req = buildHttpRequest(h, { leak: forged }, secrets);
    expect(req.url).toContain('token=pk.SUPER-SECRET-123');
    // The spilled-over `leak` value must not have round-tripped the plaintext.
    expect(req.url).not.toContain('leak=pk.SUPER-SECRET-123');
    expect(req.url).toContain('leak=');
  });

  it('keeps unresolvable refs as literals', () => {
    const h: HttpHandler = {
      kind: 'http',
      url: 'https://x.test/',
      method: 'GET',
      query: { token: '{{secret:nope/missing}}' },
    };
    const req = buildHttpRequest(h, {}, secrets);
    expect(req.url).toContain(encodeURIComponent('{{secret:nope/missing}}'));
  });
});

describe('scrubSecrets', () => {
  it('replaces plaintext and URL-encoded plaintext with the ref name', () => {
    const s = new Map([['svc/key', 'se cret']]);
    const text = 'failed: https://x.test/?t=se%20cret raw=se cret';
    expect(scrubSecrets(text, s)).toBe(
      'failed: https://x.test/?t=[secret:svc/key] raw=[secret:svc/key]',
    );
  });

  it('replaces the base64 form too (how Basic-auth secrets travel)', () => {
    const plaintext = 'pk.SUPER-SECRET-123';
    const s = new Map([['svc/key', plaintext]]);
    const b64 = Buffer.from(plaintext, 'utf8').toString('base64');
    expect(scrubSecrets(`echo: ${b64}`, s)).toBe('echo: [secret:svc/key]');
  });
});
