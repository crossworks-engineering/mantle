import { describe, expect, it } from 'vitest';
import type { GatePolicy, Tool } from '@mantle/db';
import type { BuiltinToolDef } from '@mantle/tools';
import type { McpToolEntry } from './gated-tools';
import { DESTRUCTIVE_WRITES, IDEMPOTENT_WRITES, toolAnnotations } from './tool-annotations';

/**
 * The pure derivation of the MCP tool hints from an entry and its policy.
 * The surface test (tool-annotations.surface.test.ts) pins what the real
 * registration emits for every tool; this one pins the rules.
 */

const builtin = (slug: string): McpToolEntry => ({
  kind: 'builtin',
  def: { slug } as BuiltinToolDef,
  surface: { kind: 'owner', via: 'mcp' } as never,
});
const definition = (name: string): McpToolEntry => ({
  kind: 'definition',
  name,
  description: '',
  shape: {},
  run: async () => null,
});
const connector = (slug: string): McpToolEntry => ({
  kind: 'connector',
  row: { slug } as Tool,
  surface: { kind: 'owner', via: 'mcp' } as never,
});

const read: GatePolicy = Object.freeze({ effect: 'read', scope: 'any' });
const write: GatePolicy = Object.freeze({ effect: 'write', scope: 'any' });
const egress: GatePolicy = Object.freeze({
  effect: 'write',
  scope: 'any',
  fields: { outside: { egress: true } },
});
const readEgress: GatePolicy = Object.freeze({
  effect: 'read',
  scope: 'any',
  fields: { outside: { untrusted: true, egress: true } },
});

describe('toolAnnotations', () => {
  it('a read: read-only, not destructive, idempotent, closed world', () => {
    expect(toolAnnotations(builtin('note_get'), read)).toEqual({
      title: 'note_get',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('a plain write: not read-only, not destructive, not idempotent', () => {
    expect(toolAnnotations(builtin('note_create'), write)).toEqual({
      title: 'note_create',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it('a hard delete is destructive; a soft delete with an undelete is not', () => {
    expect(toolAnnotations(builtin('page_delete'), write)?.destructiveHint).toBe(true);
    expect(toolAnnotations(builtin('app_delete'), write)?.destructiveHint).toBe(false);
    expect(DESTRUCTIVE_WRITES.has('page_delete')).toBe(true);
    expect(DESTRUCTIVE_WRITES.has('app_delete')).toBe(false);
  });

  it('an upsert is idempotent; a create is not', () => {
    expect(toolAnnotations(builtin('table_rows_upsert'), write)?.idempotentHint).toBe(true);
    expect(toolAnnotations(builtin('table_rows_add'), write)?.idempotentHint).toBe(false);
    expect(IDEMPOTENT_WRITES.has('table_rows_upsert')).toBe(true);
  });

  it('a tool whose policy reaches out, or a peer tool, is open world', () => {
    expect(toolAnnotations(builtin('email_send'), egress)?.openWorldHint).toBe(true);
    expect(toolAnnotations(builtin('web_search'), readEgress)).toEqual({
      title: 'web_search',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(toolAnnotations(builtin('peer_query'), read)?.openWorldHint).toBe(true);
    expect(toolAnnotations(builtin('search'), read)?.openWorldHint).toBe(false);
  });

  it('a definition follows the same rules under its policy', () => {
    expect(toolAnnotations(definition('page_get'), read)?.readOnlyHint).toBe(true);
    expect(toolAnnotations(definition('file_rename'), write)).toEqual({
      title: 'file_rename',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it('a connector row: hints only once confirmed read-only, always open world', () => {
    expect(toolAnnotations(connector('mcp_crm_contacts_list'), read)).toEqual({
      title: 'mcp_crm_contacts_list',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(toolAnnotations(connector('mcp_crm_contacts_update'), write)).toBeUndefined();
  });

  it('no policy: no hints', () => {
    expect(toolAnnotations(builtin('x'), null)).toBeUndefined();
    expect(toolAnnotations(builtin('x'), undefined)).toBeUndefined();
  });

  it('never says read-only for a write, whatever the name', () => {
    for (const name of ['search', 'note_get', 'page_get', ...IDEMPOTENT_WRITES]) {
      expect(toolAnnotations(builtin(name), write)?.readOnlyHint, name).toBe(false);
    }
  });

  it('the two name lists never overlap on destructive-and-idempotent except the documented overwrites', () => {
    const both = [...DESTRUCTIVE_WRITES].filter((n) => IDEMPOTENT_WRITES.has(n)).sort();
    expect(both).toEqual(['file_create', 'file_upload', 'page_discard_draft']);
  });
});
