import { describe, expect, it } from 'vitest';
import { looksLikeCurl, parseCurl, toCurl } from './curl';
import type { DraftRequest } from './types';

function parsed(input: string) {
  const r = parseCurl(input);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe('looksLikeCurl', () => {
  it('accepts plain, prompted and indented commands', () => {
    expect(looksLikeCurl('curl https://x.test')).toBe(true);
    expect(looksLikeCurl('  $ curl -X POST https://x.test')).toBe(true);
    expect(looksLikeCurl('CURL https://x.test')).toBe(true);
  });
  it('rejects non-curl text', () => {
    expect(looksLikeCurl('https://x.test/curl')).toBe(false);
    expect(looksLikeCurl('curling is a sport')).toBe(false);
  });
});

describe('parseCurl', () => {
  it('parses the weather-docs shape: query in the URL', () => {
    const v = parsed(
      'curl "https://api.openweathermap.org/data/2.5/forecast?lat=44.34&lon=10.99&appid=KEY&units=metric"',
    );
    expect(v.method).toBe('GET');
    expect(v.url).toBe('https://api.openweathermap.org/data/2.5/forecast');
    expect(v.params).toEqual([
      { key: 'lat', value: '44.34' },
      { key: 'lon', value: '10.99' },
      { key: 'appid', value: 'KEY' },
      { key: 'units', value: 'metric' },
    ]);
    expect(v.body.mode).toBe('none');
    expect(v.warnings).toEqual([]);
  });

  it('parses headers, JSON body and line continuations', () => {
    const v = parsed(
      `curl -X POST https://api.example.test/v1/items \\
        -H 'Authorization: Bearer TOKEN' \\
        -H "Content-Type: application/json" \\
        -d '{"name": "widget", "count": 2}'`,
    );
    expect(v.method).toBe('POST');
    expect(v.headers).toEqual([
      { key: 'Authorization', value: 'Bearer TOKEN' },
      { key: 'Content-Type', value: 'application/json' },
    ]);
    expect(v.body).toEqual({ mode: 'json', text: '{"name": "widget", "count": 2}' });
  });

  it('treats --json as JSON body + implied headers and POST', () => {
    const v = parsed(`curl https://api.example.test/v1 --json '{"q": 1}'`);
    expect(v.method).toBe('POST');
    expect(v.body.mode).toBe('json');
    expect(v.headers).toContainEqual({ key: 'Content-Type', value: 'application/json' });
    expect(v.headers).toContainEqual({ key: 'Accept', value: 'application/json' });
  });

  it('joins multiple -d parts as a form body with the implied content type', () => {
    const v = parsed(
      `curl https://api.example.test/token -d grant_type=client_credentials -d scope=read`,
    );
    expect(v.method).toBe('POST');
    expect(v.body).toEqual({ mode: 'raw', text: 'grant_type=client_credentials&scope=read' });
    expect(v.headers).toContainEqual({
      key: 'Content-Type',
      value: 'application/x-www-form-urlencoded',
    });
  });

  it('-G moves data into the query string', () => {
    const v = parsed(
      `curl -G https://api.example.test/search -d q=hello --data-urlencode 'name=a b'`,
    );
    expect(v.method).toBe('GET');
    expect(v.params).toContainEqual({ key: 'q', value: 'hello' });
    expect(v.params).toContainEqual({ key: 'name', value: 'a b' });
    expect(v.body.mode).toBe('none');
  });

  it('turns -u into a basic Authorization header (the stripe-docs shape)', () => {
    const v = parsed(`curl https://api.example.test/v1/charges -u sk_test_abc:`);
    expect(v.headers).toEqual([{ key: 'Authorization', value: `Basic ${btoa('sk_test_abc:')}` }]);
  });

  it('handles escaped quotes inside a double-quoted JSON body', () => {
    const v = parsed(`curl -X POST https://x.test -d "{\\"a\\": \\"b\\"}"`);
    expect(v.body).toEqual({ mode: 'json', text: '{"a": "b"}' });
  });

  it('reports skipped constructs instead of dropping them silently', () => {
    const v = parsed(`curl -F file=@photo.png --unknown-flag https://x.test`);
    expect(v.url).toBe('https://x.test');
    expect(v.warnings.some((w) => w.includes('-F/--form'))).toBe(true);
    expect(v.warnings.some((w) => w.includes('--unknown-flag'))).toBe(true);
  });

  it('rejects unbalanced quotes and missing URLs with a reason', () => {
    expect(parseCurl(`curl 'https://x.test`)).toEqual({
      ok: false,
      error: 'unbalanced quotes — check the pasted command',
    });
    expect(parseCurl('curl -X POST')).toMatchObject({ ok: false });
    expect(parseCurl('wget https://x.test')).toMatchObject({ ok: false });
  });
});

function httpDraft(over: Partial<DraftRequest>): DraftRequest {
  return {
    kind: 'http',
    name: 't',
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    body: { mode: 'none', text: '' },
    auth: { mode: 'session' },
    pathValues: {},
    targetName: '',
    argsText: '{}',
    ...over,
  };
}

describe('toCurl', () => {
  it('resolves env vars and path params but NEVER a secret ref', () => {
    const out = toCurl(
      httpDraft({
        method: 'GET',
        url: '{{baseUrl}}/v5/{profile}/route',
        pathValues: { profile: 'driving' },
        params: [
          { id: '1', enabled: true, key: 'access_token', value: '{{secret:mapbox/default}}' },
          { id: '2', enabled: true, key: 'limit', value: '{{limit}}' },
          { id: '3', enabled: false, key: 'off', value: 'x' },
        ],
      }),
      { baseUrl: 'https://api.mapbox.test', limit: '5' },
    );
    expect(out).toContain("'https://api.mapbox.test/v5/driving/route?");
    // The ref itself survives — URL-encoded as a query value, never resolved.
    expect(out).toContain('access_token=%7B%7Bsecret%3Amapbox%2Fdefault%7D%7D');
    expect(out).toContain('limit=5');
    expect(out).not.toContain('off=');
  });

  it('emits headers, bearer auth and a JSON body with safe quoting', () => {
    const out = toCurl(
      httpDraft({
        method: 'POST',
        url: 'https://x.test/items',
        headers: [{ id: '1', enabled: true, key: 'X-Team', value: 'a' }],
        auth: { mode: 'bearer', token: '{{secret:svc/default}}' },
        body: { mode: 'json', text: `{"note": "it's fine"}` },
      }),
      {},
    );
    expect(out).toContain(`-H 'X-Team: a'`);
    expect(out).toContain(`-H 'Authorization: Bearer {{secret:svc/default}}'`);
    expect(out).toContain(`-H 'Content-Type: application/json'`);
    expect(out).toContain(`-d '{"note": "it'\\''s fine"}'`);
    expect(out.startsWith('curl -X POST')).toBe(true);
  });

  it('round-trips a parsed command well enough to re-parse', () => {
    const original = `curl -X POST 'https://api.x.test/v1/items?filter=new' -H 'X-A: 1' -d '{"a": 1}'`;
    const p = parsed(original);
    const draft = httpDraft({
      method: p.method,
      url: p.url,
      params: p.params.map((q, i) => ({ id: String(i), enabled: true, ...q })),
      headers: p.headers.map((h, i) => ({ id: String(i), enabled: true, ...h })),
      body: p.body,
    });
    const again = parsed(toCurl(draft, {}));
    expect(again.method).toBe('POST');
    expect(again.url).toBe('https://api.x.test/v1/items');
    expect(again.params).toEqual([{ key: 'filter', value: 'new' }]);
    expect(again.body).toEqual({ mode: 'json', text: '{"a": 1}' });
  });
});
