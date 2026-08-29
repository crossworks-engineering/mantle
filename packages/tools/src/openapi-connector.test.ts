/**
 * End-to-end test of the OpenAPI connector path against a REAL server running
 * in-process on 127.0.0.1 (no external network): the server serves its own
 * OpenAPI spec AND implements the operations. Proves the whole wire:
 * spec fetch (size-capped) → parse → compile with the group's inheritance →
 * a materialised row dispatched through the real dispatcher, with the path
 * filled, optional query dropped, JSON body assembled, and the vault-resolved
 * auth header attached.
 *
 * The SSRF guard is stubbed because it (correctly) blocks loopback in
 * production; its own behaviour is covered by ssrf-guard tests. No DB: rows
 * are built from the compiler's output exactly as the sync would store them.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./ssrf-guard', () => ({ assertFetchableUrl: async () => {} }));
vi.mock('@mantle/api-keys', () => ({
  getApiKey: async (_owner: string, service: string, label: string) =>
    service === 'petstore' && label === 'default' ? 'live-key-9' : null,
}));

import type { Tool, ToolGroupIntegration } from '@mantle/db';
import { dispatchTool } from './dispatch';
import { compileOperations, parseOpenapiDocument } from './openapi-spec';
import { fetchSpecText, planOpenapiSync } from './openapi-sync';

const OWNER = 'owner-1';
const GROUP = 'openapi-petstore';

type Seen = { url: string; method: string; auth?: string; body?: unknown };
const seen: Seen[] = [];

let server: http.Server;
let origin: string;

const SPEC = (baseUrl: string) => ({
  openapi: '3.0.3',
  info: { title: 'In-process petstore', version: '0.0.1' },
  servers: [{ url: baseUrl }],
  paths: {
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
  },
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      if (req.url === '/openapi.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(SPEC(origin)));
        return;
      }
      seen.push({
        url: req.url!,
        method: req.method!,
        auth: req.headers['x-api-key'] as string | undefined,
        ...(raw ? { body: JSON.parse(raw) } : {}),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function rowFromPlanInsert(ins: {
  slug: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: unknown;
}): Tool {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    ownerId: OWNER,
    slug: ins.slug,
    name: ins.name,
    description: ins.description,
    inputSchema: ins.inputSchema,
    handler: ins.handler,
    requiresConfirm: false,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Tool;
}

describe('openapi connector against an in-process spec server', () => {
  it('fetches, compiles, and dispatches the materialised tools end to end', async () => {
    const { text, hash } = await fetchSpecText(`${origin}/openapi.json`);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const parsed = parseOpenapiDocument(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const integration: ToolGroupIntegration = {
      service: 'petstore',
      baseUrl: origin,
      authTemplate: { headers: { 'X-API-Key': '{{secret:petstore/default}}' } },
    };
    const compiled = compileOperations(parsed.doc, { integration });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.tools.map((t) => t.op).sort()).toEqual(['addPet', 'getPet']);

    const plan = planOpenapiSync({
      groupSlug: GROUP,
      compiled: compiled.tools,
      existing: [],
      ownerSlugs: [],
      now: '2026-08-29T12:00:00.000Z',
    });
    const bySlug = new Map(plan.inserts.map((i) => [i.slug, rowFromPlanInsert(i)]));

    // GET with the path filled, the optional query param OMITTED (dropped,
    // not sent as a literal brace string), and the vault credential attached.
    const getRow = bySlug.get('openapi_petstore_getpet')!;
    const getRes = await dispatchTool(getRow, { petId: 42 }, { ownerId: OWNER });
    expect(getRes.ok).toBe(true);
    let call = seen.pop()!;
    expect(call.method).toBe('GET');
    expect(call.url).toBe('/pets/42');
    expect(call.auth).toBe('live-key-9');

    // Same GET with the optional param present.
    await dispatchTool(getRow, { petId: 7, verbose: true }, { ownerId: OWNER });
    call = seen.pop()!;
    expect(call.url).toBe('/pets/7?verbose=true');

    // POST: spread body fields ride the spillover as the JSON body.
    const postRow = bySlug.get('openapi_petstore_addpet')!;
    const postRes = await dispatchTool(postRow, { name: 'Rex', age: 3 }, { ownerId: OWNER });
    expect(postRes.ok).toBe(true);
    call = seen.pop()!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/pets');
    expect(call.body).toEqual({ name: 'Rex', age: 3 });
    expect(call.auth).toBe('live-key-9');
  });

  it('caps the spec fetch by size with a teaching error', async () => {
    const bigServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // Stream forever-ish; the reader must bail at the cap, not buffer it all.
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      let sent = 0;
      const push = () => {
        if (sent > 7 * 1024 * 1024) return res.end();
        sent += chunk.length;
        res.write(chunk, () => setImmediate(push));
      };
      push();
    });
    await new Promise<void>((resolve) => bigServer.listen(0, '127.0.0.1', resolve));
    const { port } = bigServer.address() as AddressInfo;
    await expect(fetchSpecText(`http://127.0.0.1:${port}/openapi.json`)).rejects.toThrow(
      /5 MB cap/,
    );
    await new Promise<void>((resolve) => bigServer.close(() => resolve()));
  });
});
