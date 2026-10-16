/**
 * Two creates of the same OpenAPI connector at once (A10 lows, part 2 #3):
 * both pass the "already exists" check, and the second insert meets the
 * unique index. It answers the check's own words as a ConflictError (409 by
 * the one table), not the opaque 500 of the unique violation.
 */
import { describe, expect, it, vi } from 'vitest';

const insertError = Object.assign(
  new Error('duplicate key value violates unique constraint "tool_groups_owner_slug_uq"'),
  { code: '23505', constraint_name: 'tool_groups_owner_slug_uq' },
);

vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/db')>();
  // The check finds no group (the other create has not written yet); the
  // insert meets the one the other create wrote.
  const none = { from: () => none, where: () => none, limit: async () => [] };
  const db = {
    select: () => none,
    insert: () => ({ values: async () => Promise.reject(insertError) }),
  };
  return { ...real, db };
});

import { ConflictError } from '@mantle/std';
import { createOpenapiConnector } from './openapi-sync';

describe('createOpenapiConnector under a race', () => {
  it('the losing insert is a ConflictError with the check’s words', async () => {
    const thrown = await createOpenapiConnector('owner-1', {
      slug: 'petstore',
      specUrl: 'https://petstore.example.invalid/openapi.json',
    }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ConflictError);
    expect((thrown as Error).message).toBe(
      "connector group 'openapi-petstore' already exists — update its binding or re-run sync instead of creating it again",
    );
  });
});
