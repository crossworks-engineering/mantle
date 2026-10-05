import { describe, expect, it } from 'vitest';
import {
  buildDeferredToolset,
  CORE_TOOL_SLUGS,
  isAlwaysFull,
  TOOL_SEARCH_SLUG,
  unwrapUseTool,
  USE_TOOL_SLUG,
  type DeferredToolDef,
} from './deferred';

const def = (name: string, description: string): DeferredToolDef => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties: {} } },
});

const DEFS = [
  def('search_nodes', 'Search the brain.'),
  def('email_send', 'Send an email to a contact.'),
  def('heartbeat_complete', 'Complete the active heartbeat.'),
  def('event_create', 'Create a calendar event or a reminder.'),
  def('page_get', 'Read one page.'),
];
const GROUPS = [
  { slug: 'events', name: 'Events', description: 'Calendar', tools: ['event_create'] },
  { slug: 'email', name: 'Email', description: 'Mail', tools: ['email_send'] },
];

describe('buildDeferredToolset', () => {
  it('sends core tools in grant order, then tool_search and use_tool', () => {
    const set = buildDeferredToolset(DEFS, GROUPS)!;
    expect(set.sent.map((d) => d.function.name)).toEqual([
      'search_nodes',
      'heartbeat_complete',
      'page_get',
      TOOL_SEARCH_SLUG,
      USE_TOOL_SLUG,
    ]);
    expect([...set.deferred].sort()).toEqual(['email_send', 'event_create']);
  });

  it('is byte-stable for the same grant, whatever order the groups arrive in', () => {
    const a = JSON.stringify(buildDeferredToolset(DEFS, GROUPS)!.sent);
    const b = JSON.stringify(buildDeferredToolset(DEFS, [...GROUPS].reverse())!.sent);
    expect(a).toBe(b);
  });

  it('lists each deferred tool by name under its flow in the catalog', () => {
    const search = buildDeferredToolset(DEFS, GROUPS)!.sent.find(
      (d) => d.function.name === TOOL_SEARCH_SLUG,
    )!;
    expect(search.function.description).toMatch(/- people \(.*\): email_send/);
    expect(search.function.description).toMatch(/- plan \(.*\): event_create/);
    const catalog = search.function.description.split('Tool catalog')[1]!;
    expect(catalog).not.toContain('search_nodes');
  });

  it('returns the full schema of the best match', () => {
    const r = buildDeferredToolset(DEFS, GROUPS)!.search('remind me to call mom');
    expect(r.tools[0]!.name).toBe('event_create');
    expect(r.tools[0]!.input_schema).toEqual({ type: 'object', properties: {} });
  });

  it('returns null when every granted tool is already sent in full', () => {
    expect(buildDeferredToolset([def('search_nodes', 'x'), def('page_get', 'y')], [])).toBeNull();
  });

  it('keeps the core list small and heartbeat tools always in full', () => {
    expect(CORE_TOOL_SLUGS.length).toBeLessThanOrEqual(24);
    expect(isAlwaysFull('heartbeat_snooze')).toBe(true);
    expect(isAlwaysFull('email_send')).toBe(false);
  });
});

describe('unwrapUseTool', () => {
  it('unwraps the inner call', () => {
    expect(unwrapUseTool('{"name":"email_send","arguments":{"to":"a"}}')).toEqual({
      ok: true,
      slug: 'email_send',
      argumentsRaw: '{"to":"a"}',
    });
  });

  it('refuses a missing name, a non-object arguments, and nesting', () => {
    expect(unwrapUseTool('{"arguments":{}}').ok).toBe(false);
    expect(unwrapUseTool('{"name":"x","arguments":[1]}').ok).toBe(false);
    expect(unwrapUseTool('{"name":"use_tool","arguments":{}}').ok).toBe(false);
    expect(unwrapUseTool('not json').ok).toBe(false);
  });
});
