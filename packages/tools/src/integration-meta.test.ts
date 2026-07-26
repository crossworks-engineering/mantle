/**
 * Integration-group rules: what a valid `integration` blob is, and exactly what
 * a tool authored INTO a group inherits. The inheritance is the load-bearing
 * part — it resolves at authoring time into the stored handler, so a mistake
 * here is baked into every tool the group ever gets.
 */

import { describe, expect, it } from 'vitest';
import {
  applyIntegrationInheritance,
  apiDocsHeader,
  describeInheritance,
  joinBaseUrl,
  parseIntegrationMeta,
} from './integration-meta';
import { collectSecretRefs, refKey } from './http-template';

const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  expect(r.ok, 'error' in r ? String((r as { error: string }).error) : '').toBe(true);
  return r as Extract<T, { ok: true }>;
};

describe('parseIntegrationMeta', () => {
  it('requires a service and keeps the minimal shape', () => {
    const bad = parseIntegrationMeta({});
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/service is required/);

    const good = ok(parseIntegrationMeta({ service: 'openweathermap' }));
    expect(good.value).toEqual({ service: 'openweathermap' });
    expect(good.warnings).toEqual([]);
  });

  it('rejects a service that is really a sentence', () => {
    const r = parseIntegrationMeta({ service: 'the weather api we use' });
    expect(r.ok).toBe(false);
  });

  it('accepts snake_case (tool input) and camelCase (API/DB) alike', () => {
    const snake = ok(
      parseIntegrationMeta({
        service: 'x',
        base_url: 'https://api.example.com/v1',
        secret_ref: 'x/default',
      }),
    );
    const camel = ok(
      parseIntegrationMeta({
        service: 'x',
        baseUrl: 'https://api.example.com/v1',
        secretRef: 'x/default',
      }),
    );
    expect(snake.value).toEqual(camel.value);
  });

  it('unwraps a secret ref handed over in {{secret:…}} form', () => {
    const r = ok(parseIntegrationMeta({ service: 'x', secret_ref: '{{secret:x/default}}' }));
    expect(r.value.secretRef).toBe('x/default');
  });

  it('rejects a secret ref that is not service/label', () => {
    for (const ref of ['justaservice', 'a/b/c', 'sk-live-abcd1234']) {
      const r = parseIntegrationMeta({ service: 'x', secret_ref: ref });
      expect(r.ok, ref).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/service\/label/);
    }
  });

  it('accepts every ref the vault can produce (charset parity with http-template)', () => {
    const ref = 'open-weather.map_v2/prod-key.1';
    const r = ok(parseIntegrationMeta({ service: 'x', secret_ref: ref }));
    expect(r.value.secretRef).toBe(ref);
    // The same ref, written as a template, must resolve through the dispatcher's
    // own pattern — otherwise a group could record a ref no tool can use.
    const refs = collectSecretRefs({
      kind: 'http',
      url: `https://api.example.com?k={{secret:${ref}}}`,
    });
    expect(refs.map(refKey)).toEqual([ref]);
  });

  it('rejects a non-http base URL', () => {
    for (const url of ['api.example.com', 'ftp://example.com', 'https://ex ample.com']) {
      expect(parseIntegrationMeta({ service: 'x', base_url: url }).ok, url).toBe(false);
    }
  });

  it('only allows headers/query in the auth template', () => {
    const r = parseIntegrationMeta({
      service: 'x',
      auth_template: { headers: { a: 'b' }, body: 'nope' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/only carry/);
  });

  it('rejects non-string auth-template values', () => {
    const r = parseIntegrationMeta({ service: 'x', auth_template: { query: { appid: 42 } } });
    expect(r.ok).toBe(false);
  });

  it('warns — but does not fail — when a credential is literal instead of a vault ref', () => {
    const r = ok(
      parseIntegrationMeta({
        service: 'x',
        auth_template: { headers: { Authorization: 'Bearer sk-live-1234' } },
      }),
    );
    expect(r.warnings.join(' ')).toMatch(/vault ref/);
  });

  it('does not warn when the credential is a vault ref', () => {
    const r = ok(
      parseIntegrationMeta({
        service: 'x',
        secret_ref: 'x/default',
        auth_template: { headers: { Authorization: 'Bearer {{secret:x/default}}' } },
      }),
    );
    expect(r.warnings).toEqual([]);
  });

  it('warns when a ref is bound but nothing says where it goes', () => {
    const r = ok(parseIntegrationMeta({ service: 'x', secret_ref: 'x/default' }));
    expect(r.warnings.join(' ')).toMatch(/auth_template is empty/);
  });

  it('refuses a docs node id that is not the id api_docs_set returned', () => {
    expect(parseIntegrationMeta({ service: 'x', docs_node_id: 'files/api-docs/x.md' }).ok).toBe(
      false,
    );
    const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(ok(parseIntegrationMeta({ service: 'x', docs_node_id: uuid })).value.docsNodeId).toBe(
      uuid,
    );
  });
});

describe('joinBaseUrl', () => {
  it('joins without doubling or dropping a slash', () => {
    expect(joinBaseUrl('https://a.com/v1', '/weather')).toBe('https://a.com/v1/weather');
    expect(joinBaseUrl('https://a.com/v1/', '/weather')).toBe('https://a.com/v1/weather');
    expect(joinBaseUrl('https://a.com/v1//', 'weather')).toBe('https://a.com/v1/weather');
  });

  it('returns the base for an empty path and appends a bare query/fragment', () => {
    expect(joinBaseUrl('https://a.com/v1/', '')).toBe('https://a.com/v1');
    expect(joinBaseUrl('https://a.com/v1', '?q=1')).toBe('https://a.com/v1?q=1');
    expect(joinBaseUrl('https://a.com/v1', '#frag')).toBe('https://a.com/v1#frag');
  });

  it('leaves {param} placeholders untouched', () => {
    expect(joinBaseUrl('https://a.com/v1', '/city/{city}/now?units={units}')).toBe(
      'https://a.com/v1/city/{city}/now?units={units}',
    );
  });
});

const GROUP = {
  service: 'openweathermap',
  baseUrl: 'https://api.openweathermap.org/data/2.5',
  secretRef: 'openweathermap/default',
  authTemplate: {
    query: { appid: '{{secret:openweathermap/default}}' },
    headers: { Authorization: 'Bearer {{secret:openweathermap/default}}' },
  },
} as const;

describe('applyIntegrationInheritance', () => {
  it('joins a relative url and merges the group auth in', () => {
    const r = ok(applyIntegrationInheritance({ ...GROUP }, { url: '/weather' }));
    expect(r.url).toBe('https://api.openweathermap.org/data/2.5/weather');
    expect(r.query).toEqual({ appid: '{{secret:openweathermap/default}}' });
    expect(r.headers).toEqual({ Authorization: 'Bearer {{secret:openweathermap/default}}' });
    expect(r.inherited.baseUrl).toBe(GROUP.baseUrl);
    expect(r.inherited.query).toEqual(['appid']);
    expect(r.inherited.overridden).toEqual([]);
  });

  it('leaves an absolute url alone (and reports no inherited base)', () => {
    const r = ok(applyIntegrationInheritance({ ...GROUP }, { url: 'https://other.example.com/x' }));
    expect(r.url).toBe('https://other.example.com/x');
    expect(r.inherited.baseUrl).toBeUndefined();
    // Auth still merges — the credential is the group's, wherever the call goes.
    expect(r.query).toEqual({ appid: '{{secret:openweathermap/default}}' });
  });

  it('the TOOL wins on a query-key conflict', () => {
    const r = ok(
      applyIntegrationInheritance({ ...GROUP }, { url: '/weather', query: { appid: '{key}' } }),
    );
    expect(r.query).toEqual({ appid: '{key}' });
    expect(r.inherited.query).toEqual([]);
    expect(r.inherited.overridden).toContain('appid');
  });

  it('the TOOL wins on a header conflict regardless of case', () => {
    const r = ok(
      applyIntegrationInheritance(
        { ...GROUP },
        { url: '/weather', headers: { authorization: 'Basic {creds}' } },
      ),
    );
    // Exactly one authorization header — never both spellings.
    expect(Object.keys(r.headers ?? {})).toEqual(['authorization']);
    expect(r.headers).toEqual({ authorization: 'Basic {creds}' });
    expect(r.inherited.overridden).toContain('Authorization');
  });

  it("keeps the tool's own non-conflicting headers and query alongside the group's", () => {
    const r = ok(
      applyIntegrationInheritance(
        { ...GROUP },
        { url: '/weather', headers: { accept: 'application/json' }, query: { units: '{units}' } },
      ),
    );
    expect(r.headers).toEqual({
      Authorization: 'Bearer {{secret:openweathermap/default}}',
      accept: 'application/json',
    });
    expect(r.query).toEqual({ appid: '{{secret:openweathermap/default}}', units: '{units}' });
  });

  it('refuses a relative url when the group has no base URL, and says how to fix it', () => {
    const r = applyIntegrationInheritance({ service: 'x' }, { url: '/weather' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no base_url/);
  });

  it('with no group at all, an absolute url passes through untouched', () => {
    const r = ok(
      applyIntegrationInheritance(null, {
        url: 'https://a.com/x',
        headers: { a: 'b' },
        query: { c: 'd' },
      }),
    );
    expect(r).toMatchObject({ url: 'https://a.com/x', headers: { a: 'b' }, query: { c: 'd' } });
    expect(r.inherited).toEqual({ headers: [], query: [], overridden: [] });
  });

  it('with no group, a relative url is refused', () => {
    expect(applyIntegrationInheritance(null, { url: '/weather' }).ok).toBe(false);
  });

  it('a group with no auth template contributes only the base URL', () => {
    const r = ok(
      applyIntegrationInheritance(
        { service: 'x', baseUrl: 'https://a.com/v1' },
        { url: 'items/{id}' },
      ),
    );
    expect(r.url).toBe('https://a.com/v1/items/{id}');
    expect(r.headers).toBeUndefined();
    expect(r.query).toBeUndefined();
  });
});

describe('describeInheritance', () => {
  it('names the pieces the group contributed', () => {
    const r = ok(applyIntegrationInheritance({ ...GROUP }, { url: '/weather' }));
    const line = describeInheritance(r.inherited);
    expect(line).toContain('base_url https://api.openweathermap.org/data/2.5');
    expect(line).toContain('query appid');
  });

  it('says so plainly when nothing was inherited', () => {
    const r = ok(applyIntegrationInheritance(null, { url: 'https://a.com' }));
    expect(describeInheritance(r.inherited)).toMatch(/nothing inherited/);
  });
});

describe('apiDocsHeader', () => {
  it('records provenance and points the next reader at the stored copy', () => {
    const h = apiDocsHeader({
      groupSlug: 'weather-tools',
      service: 'openweathermap',
      sourceUrl: 'https://openweathermap.org/api/one-call-3',
      capturedAt: '2026-07-26T00:00:00.000Z',
    });
    expect(h).toContain('# openweathermap API documentation');
    expect(h).toContain('`weather-tools`');
    expect(h).toContain('https://openweathermap.org/api/one-call-3');
    expect(h).toContain('2026-07-26T00:00:00.000Z');
    expect(h).toMatch(/api_docs_get/);
  });

  it('is explicit when there was no source URL', () => {
    expect(apiDocsHeader({ groupSlug: 'g' })).toContain('supplied directly (no URL)');
  });
});
