import { describe, expect, it } from 'vitest';
import type { GatePolicy, Tool } from '@mantle/db';
import type { BuiltinToolDef } from '@mantle/tools';
import type { McpToolEntry } from './gated-tools';
import { toolAnnotations } from './tool-annotations';

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

const policy = (effect: 'read' | 'write', fields?: Record<string, unknown>): GatePolicy =>
  Object.freeze({ effect, scope: 'any', ...(fields ? { fields } : {}) });
const read = policy('read');
const write = policy('write');

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

  it('a write whose policy says destructive is; one that does not is not', () => {
    const del = toolAnnotations(builtin('page_delete'), policy('write', { destructive: true }));
    expect(del?.destructiveHint).toBe(true);
    expect(del?.idempotentHint).toBe(false);
    expect(toolAnnotations(builtin('app_delete'), write)?.destructiveHint).toBe(false);
  });

  it('a write whose policy says idempotent is; a create is not', () => {
    const up = toolAnnotations(builtin('table_rows_upsert'), policy('write', { idempotent: true }));
    expect(up?.idempotentHint).toBe(true);
    expect(up?.destructiveHint).toBe(false);
    expect(toolAnnotations(builtin('table_rows_add'), write)?.idempotentHint).toBe(false);
  });

  it('a read ignores destructive and idempotent marks: never destructive, always idempotent', () => {
    const r = toolAnnotations(builtin('x_get'), policy('read', { destructive: true }));
    expect(r?.destructiveHint).toBe(false);
    expect(r?.idempotentHint).toBe(true);
  });

  it('a tool whose policy reaches out (egress or a peer) is open world', () => {
    const egress = policy('write', { outside: { egress: true } });
    expect(toolAnnotations(builtin('email_send'), egress)?.openWorldHint).toBe(true);
    const search = policy('read', { outside: { untrusted: true, egress: true } });
    expect(toolAnnotations(builtin('web_search'), search)).toEqual({
      title: 'web_search',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    const peer = policy('read', { outside: { via: 'peer', untrusted: true } });
    expect(toolAnnotations(builtin('peer_query'), peer)?.openWorldHint).toBe(true);
    const untrusted = policy('read', { outside: { untrusted: true } });
    expect(toolAnnotations(builtin('email_get'), untrusted)?.openWorldHint).toBe(false);
    expect(toolAnnotations(builtin('search'), read)?.openWorldHint).toBe(false);
    // An api row carries a string there (runtime-policy.ts): not an object, not open.
    expect(toolAnnotations(builtin('x'), policy('write', { outside: 'http' }))?.openWorldHint).toBe(
      false,
    );
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

  it('never says read-only for a write, whatever the fields say', () => {
    for (const fields of [{}, { idempotent: true }, { outside: { untrusted: true } }]) {
      expect(toolAnnotations(builtin('search'), policy('write', fields))?.readOnlyHint).toBe(false);
    }
  });
});
