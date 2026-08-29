/**
 * Pure tests for the OpenAPI spec compiler: parsing (JSON + YAML, 3.0/3.1,
 * Swagger 2 refusal), internal-$ref resolution under caps, inventory
 * extraction, selection matching, and operation → http-handler compilation
 * (path/query/body mapping, name sanitisation, secret-ref stripping,
 * servers-override ignoring). No network, no DB.
 */

import { describe, expect, it } from 'vitest';
import type { ToolGroupIntegration } from '@mantle/db';
import {
  compileOperations,
  extractInventory,
  operationKeyOf,
  operationSelected,
  parseOpenapiDocument,
  stripSecretRefs,
} from './openapi-spec';

const INTEGRATION: ToolGroupIntegration = {
  service: 'petstore',
  baseUrl: 'https://api.pets.example',
  authTemplate: { headers: { 'X-API-Key': '{{secret:petstore/default}}' } },
};

function baseDoc(paths: Record<string, unknown>): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: { title: 'Petstore', version: '1.2.3' },
    servers: [{ url: 'https://api.pets.example/' }],
    paths,
  };
}

describe('parseOpenapiDocument', () => {
  it('parses JSON and YAML', () => {
    const doc = baseDoc({ '/pets': { get: { operationId: 'listPets' } } });
    const json = parseOpenapiDocument(JSON.stringify(doc));
    expect(json.ok && json.format).toBe('json');
    const yaml = parseOpenapiDocument(
      'openapi: "3.1.0"\ninfo: {title: T, version: "1"}\npaths:\n  /a:\n    get:\n      operationId: opA\n',
    );
    expect(yaml.ok && yaml.format).toBe('yaml');
  });

  it('refuses Swagger 2.0 with a converter pointer', () => {
    const res = parseOpenapiDocument(JSON.stringify({ swagger: '2.0', paths: {} }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('swagger2openapi');
  });

  it('refuses non-3.x and pathless documents', () => {
    expect(parseOpenapiDocument(JSON.stringify({ openapi: '4.0' })).ok).toBe(false);
    expect(parseOpenapiDocument(JSON.stringify({ openapi: '3.1.0' })).ok).toBe(false);
    expect(parseOpenapiDocument('not { json or yaml [').ok).toBe(false);
  });
});

describe('operation identity + selection', () => {
  it('prefers operationId, falls back to method + path', () => {
    expect(operationKeyOf('GET', '/pets', 'listPets')).toBe('listPets');
    expect(operationKeyOf('GET', '/pets')).toBe('get /pets');
  });

  it('matches by tag, operationId, and case-insensitive method + exact path', () => {
    const op = {
      op: 'listPets',
      method: 'get' as const,
      path: '/pets',
      operationId: 'listPets',
      tags: ['pets'],
    };
    expect(operationSelected(op, undefined)).toBe(true);
    expect(operationSelected(op, { tags: ['pets'] })).toBe(true);
    expect(operationSelected(op, { tags: ['other'] })).toBe(false);
    expect(operationSelected(op, { operations: ['listPets'] })).toBe(true);
    expect(operationSelected(op, { operations: ['GET /pets'] })).toBe(true);
    expect(operationSelected(op, { operations: ['GET /Pets'] })).toBe(false);
    expect(operationSelected(op, { operations: ['nope'], tags: ['nope'] })).toBe(false);
  });
});

describe('extractInventory', () => {
  it('lists operations, tags with counts, servers, and security schemes', () => {
    const doc = baseDoc({
      '/pets': {
        get: { operationId: 'listPets', summary: 'List pets', tags: ['pets'] },
        post: { operationId: 'addPet', tags: ['pets', 'write'] },
      },
    });
    (doc.components as unknown) = {
      securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
    };
    const inv = extractInventory(doc);
    expect(inv.title).toBe('Petstore');
    expect(inv.version).toBe('1.2.3');
    expect(inv.servers).toEqual(['https://api.pets.example']);
    expect(inv.tags).toEqual([
      { name: 'pets', count: 2 },
      { name: 'write', count: 1 },
    ]);
    expect(inv.operations.map((o) => o.op)).toEqual(['listPets', 'addPet']);
    expect(inv.securitySchemes[0]).toMatchObject({ name: 'key', type: 'apiKey', in: 'header' });
  });

  it('excludes templated and relative servers', () => {
    const doc = baseDoc({ '/a': { get: {} } });
    doc.servers = [{ url: 'https://{region}.api.example' }, { url: '/v2' }];
    expect(extractInventory(doc).servers).toEqual([]);
  });
});

describe('compileOperations', () => {
  it('compiles a GET with path + optional query params onto the group base URL', () => {
    const doc = baseDoc({
      '/pets/{petId}': {
        get: {
          operationId: 'getPet',
          summary: 'Fetch one pet',
          parameters: [
            { name: 'petId', in: 'path', required: true, schema: { type: 'integer' } },
            { name: 'verbose', in: 'query', schema: { type: 'boolean' } },
          ],
        },
      },
    });
    const res = compileOperations(doc, { integration: INTEGRATION });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [t] = res.tools;
    expect(t!.handler.url).toBe('https://api.pets.example/pets/{petId}');
    expect(t!.handler.method).toBe('GET');
    expect(t!.handler.query).toEqual({ verbose: '{verbose}' });
    // Group auth folded in by the same inheritance authored tools use.
    expect(t!.handler.headers).toEqual({ 'X-API-Key': '{{secret:petstore/default}}' });
    expect(t!.inputSchema.required).toEqual(['petId']);
    expect((t!.inputSchema.properties as Record<string, unknown>).verbose).toMatchObject({
      type: 'boolean',
    });
    expect(t!.inputSchema.additionalProperties).toBe(false);
    expect(t!.description).toBe('Fetch one pet');
  });

  it('spreads a JSON object body at the top level; required only when the body is required', () => {
    const doc = baseDoc({
      '/pets': {
        post: {
          operationId: 'addPet',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { name: { type: 'string' }, age: { type: 'integer' } },
                  required: ['name'],
                },
              },
            },
          },
        },
      },
    });
    const res = compileOperations(doc, { integration: INTEGRATION });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [t] = res.tools;
    expect(t!.handler.body).toBeUndefined(); // spillover carries the body
    expect(Object.keys(t!.inputSchema.properties as object).sort()).toEqual(['age', 'name']);
    expect(t!.inputSchema.required).toEqual(['name']);
  });

  it('nests the body under {body} when a field collides with a param', () => {
    const doc = baseDoc({
      '/things/{name}': {
        put: {
          operationId: 'renameThing',
          parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { name: { type: 'string' } } },
              },
            },
          },
        },
      },
    });
    const res = compileOperations(doc, { integration: INTEGRATION });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [t] = res.tools;
    expect(t!.handler.body).toBe('{body}');
    expect(Object.keys(t!.inputSchema.properties as object).sort()).toEqual(['body', 'name']);
    expect(t!.inputSchema.required).toEqual(['name', 'body']);
  });

  it('sanitises non-identifier param names and keeps the wire name', () => {
    const doc = baseDoc({
      '/list': {
        get: {
          operationId: 'list',
          parameters: [{ name: 'page[size]', in: 'query', schema: { type: 'integer' } }],
        },
      },
    });
    const res = compileOperations(doc, { integration: INTEGRATION });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [t] = res.tools;
    expect(t!.handler.query).toEqual({ 'page[size]': '{page_size}' });
    const prop = (t!.inputSchema.properties as Record<string, Record<string, unknown>>).page_size;
    expect(String(prop!.description)).toContain("sent to the API as 'page[size]'");
  });

  it('resolves internal $refs and degrades cycles to open objects', () => {
    const doc = baseDoc({
      '/nodes': {
        post: {
          operationId: 'addNode',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Node' } },
            },
          },
        },
      },
    });
    (doc.components as unknown) = {
      schemas: {
        Node: {
          type: 'object',
          properties: {
            label: { $ref: '#/components/schemas/Label' },
            child: { $ref: '#/components/schemas/Node' }, // cycle
          },
        },
        Label: { type: 'string' },
      },
    };
    const res = compileOperations(doc, { integration: INTEGRATION });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const props = res.tools[0]!.inputSchema.properties as Record<string, unknown>;
    expect(props.label).toMatchObject({ type: 'string' });
    expect(props.child).toEqual({}); // cycle degraded, still callable
  });

  it('strips {{secret: openers from every spec-derived string', () => {
    expect(stripSecretRefs('use {{secret:svc/label}} here')).toBe(
      'use {{blocked-secret:svc/label}} here',
    );
    const doc = baseDoc({
      '/x': {
        get: {
          operationId: 'x',
          description: 'send {{secret:petstore/default}} along',
        },
      },
    });
    const res = compileOperations(doc, { integration: INTEGRATION });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.tools[0]!.description).not.toContain('{{secret:');
  });

  it('skips non-JSON bodies and unsupported methods with warnings, ignores path-level servers', () => {
    const doc = baseDoc({
      '/upload': {
        servers: [{ url: 'https://elsewhere.example' }],
        post: {
          operationId: 'upload',
          requestBody: { content: { 'multipart/form-data': { schema: {} } } },
        },
        head: { operationId: 'probe' },
      },
    });
    const res = compileOperations(doc, { integration: INTEGRATION });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.tools).toHaveLength(0);
    const joined = res.warnings.join('\n');
    expect(joined).toContain('multipart/form-data');
    expect(joined).toContain('elsewhere.example');
    expect(joined).toContain("method 'HEAD'");
  });

  it('fails with a teaching error when the group has no base_url', () => {
    const doc = baseDoc({ '/a': { get: { operationId: 'a' } } });
    const res = compileOperations(doc, { integration: { service: 'x' } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('base_url');
  });

  it('warns when a spec param shadows a group auth key', () => {
    const integration: ToolGroupIntegration = {
      service: 'w',
      baseUrl: 'https://api.w.example',
      authTemplate: { query: { appid: '{{secret:w/default}}' } },
    };
    const doc = baseDoc({
      '/data': {
        get: {
          operationId: 'data',
          parameters: [{ name: 'appid', in: 'query', schema: { type: 'string' } }],
        },
      },
    });
    const res = compileOperations(doc, { integration });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.warnings.join('\n')).toContain('shadow');
  });

  it('applies selection before compiling and reports the pre-selection total', () => {
    const doc = baseDoc({
      '/a': { get: { operationId: 'a', tags: ['keep'] } },
      '/b': { get: { operationId: 'b' } },
    });
    const res = compileOperations(doc, { integration: INTEGRATION, selection: { tags: ['keep'] } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.tools.map((t) => t.op)).toEqual(['a']);
    expect(res.operationsTotal).toBe(2);
    expect(res.suggestedBaseUrl).toBe('https://api.pets.example');
  });
});
