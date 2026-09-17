/**
 * Pure tests for the OpenAPI sync plan: insert/update/disable reconciliation
 * keyed by operation identity, the vanish-marker asymmetry (sync-disables
 * auto-re-enable, owner-disables never do), edited-row preservation, and
 * slug namespacing. No DB.
 */

import { describe, expect, it } from 'vitest';
import type { CompiledOperation } from './openapi-spec';
import {
  openapiGroupSlug,
  openapiToolSlug,
  planOpenapiSync,
  type OpenapiSyncRowState,
} from './openapi-sync';

const GROUP = 'openapi-petstore';
const NOW = '2026-08-29T12:00:00.000Z';

function compiled(op: string, extra?: Partial<CompiledOperation>): CompiledOperation {
  return {
    op,
    method: 'GET',
    path: `/${op}`,
    name: op,
    description: `desc ${op}`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: { kind: 'http', url: `https://api.example/${op}`, method: 'GET' },
    ...extra,
  };
}

function row(op: string, extra?: Partial<OpenapiSyncRowState>): OpenapiSyncRowState {
  return {
    slug: `openapi_petstore_${op}`,
    name: op,
    description: `desc ${op}`,
    enabled: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: {
      kind: 'http',
      url: `https://api.example/${op}`,
      method: 'GET',
      openapi: { group: GROUP, op },
    },
    ...extra,
  };
}

describe('slug helpers', () => {
  it('prefixes and namespaces', () => {
    expect(openapiGroupSlug('petstore')).toBe('openapi-petstore');
    expect(openapiGroupSlug('openapi-petstore')).toBe('openapi-petstore');
    const taken = new Set<string>();
    expect(openapiToolSlug(GROUP, 'getPetById', taken)).toBe('openapi_petstore_getpetbyid');
    expect(openapiToolSlug(GROUP, 'get /pets/{id}', taken)).toBe('openapi_petstore_get_pets_id');
    taken.add('openapi_petstore_getpetbyid');
    expect(openapiToolSlug(GROUP, 'getPetById', taken)).toBe('openapi_petstore_getpetbyid_2');
  });
});

describe('planOpenapiSync', () => {
  it('inserts new operations with provenance and sorted membership', () => {
    const plan = planOpenapiSync({
      groupSlug: GROUP,
      compiled: [compiled('b'), compiled('a')],
      existing: [],
      ownerSlugs: [],
      now: NOW,
    });
    expect(plan.inserts).toHaveLength(2);
    expect(plan.inserts[0]!.handler.openapi).toEqual({ group: GROUP, op: 'b' });
    expect(plan.toolSlugs).toEqual(['openapi_petstore_a', 'openapi_petstore_b']);
  });

  it('updates only rows whose compiled output changed', () => {
    const plan = planOpenapiSync({
      groupSlug: GROUP,
      compiled: [compiled('a'), compiled('b', { description: 'fresh text' })],
      existing: [row('a'), row('b')],
      ownerSlugs: ['openapi_petstore_a', 'openapi_petstore_b'],
      now: NOW,
    });
    expect(plan.inserts).toHaveLength(0);
    expect(plan.updates).toEqual([{ slug: 'openapi_petstore_b', description: 'fresh text' }]);
    expect(plan.toolSlugs).toHaveLength(2);
  });

  it('disables vanished/deselected operations with a marker, never deletes', () => {
    const plan = planOpenapiSync({
      groupSlug: GROUP,
      compiled: [compiled('a')],
      existing: [row('a'), row('gone')],
      ownerSlugs: ['openapi_petstore_a', 'openapi_petstore_gone'],
      now: NOW,
    });
    expect(plan.disables).toHaveLength(1);
    expect(plan.disables[0]!.handler.openapi.vanishedAt).toBe(NOW);
    expect(plan.toolSlugs).toEqual(['openapi_petstore_a']);
  });

  it('re-enables a returned sync-disabled row but never an owner-disabled one', () => {
    const syncDisabled = row('a', { enabled: false });
    syncDisabled.handler.openapi.vanishedAt = '2026-08-01T00:00:00.000Z';
    const ownerDisabled = row('b', { enabled: false });
    const plan = planOpenapiSync({
      groupSlug: GROUP,
      compiled: [compiled('a'), compiled('b')],
      existing: [syncDisabled, ownerDisabled],
      ownerSlugs: ['openapi_petstore_a', 'openapi_petstore_b'],
      now: NOW,
    });
    const aPatch = plan.updates.find((u) => u.slug === 'openapi_petstore_a');
    expect(aPatch?.enabled).toBe(true);
    expect(aPatch?.handler?.openapi.vanishedAt).toBeUndefined();
    expect(plan.updates.find((u) => u.slug === 'openapi_petstore_b')).toBeUndefined();
    // Owner-disabled b stays out of membership until re-enabled by hand.
    expect(plan.toolSlugs).toEqual(['openapi_petstore_a']);
  });

  it('keeps hand-edited rows untouched and reports them', () => {
    const edited = row('a', { description: 'my better text' });
    edited.handler.openapi.editedAt = '2026-08-20T00:00:00.000Z';
    const plan = planOpenapiSync({
      groupSlug: GROUP,
      compiled: [compiled('a')],
      existing: [edited],
      ownerSlugs: ['openapi_petstore_a'],
      now: NOW,
    });
    expect(plan.updates).toHaveLength(0);
    expect(plan.keptEdited).toEqual(['openapi_petstore_a']);
    expect(plan.toolSlugs).toEqual(['openapi_petstore_a']);
  });

  it('overwriteEdited restores the compiled definition and clears the stamp', () => {
    const edited = row('a', { description: 'my better text' });
    edited.handler.openapi.editedAt = '2026-08-20T00:00:00.000Z';
    const plan = planOpenapiSync({
      groupSlug: GROUP,
      compiled: [compiled('a')],
      existing: [edited],
      ownerSlugs: ['openapi_petstore_a'],
      overwriteEdited: true,
      now: NOW,
    });
    expect(plan.keptEdited).toHaveLength(0);
    const patch = plan.updates[0]!;
    expect(patch.description).toBe('desc a');
    expect(patch.handler?.openapi).toEqual({ group: GROUP, op: 'a' });
  });

  it('an edited row that vanished and returned is re-enabled with its edit intact', () => {
    const r = row('a', { enabled: false, description: 'edited text' });
    r.handler.openapi.editedAt = '2026-08-10T00:00:00.000Z';
    r.handler.openapi.vanishedAt = '2026-08-15T00:00:00.000Z';
    const plan = planOpenapiSync({
      groupSlug: GROUP,
      compiled: [compiled('a')],
      existing: [r],
      ownerSlugs: ['openapi_petstore_a'],
      now: NOW,
    });
    const patch = plan.updates[0]!;
    expect(patch.enabled).toBe(true);
    expect(patch.handler?.openapi.vanishedAt).toBeUndefined();
    expect(patch.handler?.openapi.editedAt).toBe('2026-08-10T00:00:00.000Z');
    expect(patch.description).toBeUndefined(); // the edit survives
  });

  it('identity is the operation, not the slug — a duplicate compiled op gets one row', () => {
    const plan = planOpenapiSync({
      groupSlug: GROUP,
      compiled: [compiled('a'), compiled('a', { description: 'dupe' })],
      existing: [],
      ownerSlugs: [],
      now: NOW,
    });
    expect(plan.inserts).toHaveLength(1);
  });

  it('new slugs avoid every owner slug, not just group slugs', () => {
    const plan = planOpenapiSync({
      groupSlug: GROUP,
      compiled: [compiled('a')],
      existing: [],
      ownerSlugs: ['openapi_petstore_a'],
      now: NOW,
    });
    expect(plan.inserts[0]!.slug).toBe('openapi_petstore_a_2');
  });
});
