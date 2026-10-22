/**
 * narrowSpotFor (narrow-spots.ts): the spots per table in one place, and a
 * set that needs more than one entering each.
 */
import { describe, expect, it } from 'vitest';
import { NARROW_TABLE_SPOTS, narrowSpotFor } from './narrow-spots';
import {
  agentGroups,
  agents,
  aiWorkers,
  calendarAccounts,
  heartbeats,
  nodes,
  skills,
  toolGroups,
  tools,
} from './schema';

describe('narrowSpotFor', () => {
  it('an edit the narrow login may make needs no spot', () => {
    expect(narrowSpotFor(agents, 'update', { name: 'n', updatedAt: new Date() })).toEqual([]);
    expect(narrowSpotFor(toolGroups, 'update', { enabled: false })).toEqual([]);
  });
  it("a worker's vault key and prompt in one edit enter both spots (not skill-text alone)", () => {
    expect(narrowSpotFor(aiWorkers, 'update', { apiKeyId: 'k', params: {} })).toEqual([
      'skill-text',
      'model-route',
    ]);
    expect(narrowSpotFor(aiWorkers, 'update', { systemPrompt: 'p' })).toEqual(['skill-text']);
    expect(narrowSpotFor(aiWorkers, 'update', { apiKeyId: 'k' })).toEqual(['model-route']);
  });
  it("an assistant's grant, text and vault key: each its spot, all three together", () => {
    expect(narrowSpotFor(agents, 'update', { toolGroupSlugs: [] })).toEqual(['assistant-grant']);
    expect(narrowSpotFor(agents, 'update', { enabled: true })).toEqual(['assistant-grant']);
    expect(narrowSpotFor(agents, 'update', { memoryConfig: { delegate_to: [] } })).toEqual([
      'assistant-grant',
      'skill-text',
    ]);
    expect(narrowSpotFor(agents, 'update', { memoryConfig: { max: 1 } })).toEqual(['skill-text']);
    expect(
      narrowSpotFor(agents, 'update', { role: 'admin', systemPrompt: 'p', apiKeyId: 'k' }),
    ).toEqual(['assistant-grant', 'skill-text', 'model-route']);
  });
  it("a group's tools or turn-on is its grant; its integration its config", () => {
    expect(narrowSpotFor(toolGroups, 'update', { toolSlugs: [], enabled: true })).toEqual([
      'tool-group-grant',
    ]);
    expect(narrowSpotFor(toolGroups, 'update', { integration: null })).toEqual(['tool-config']);
    expect(narrowSpotFor(toolGroups, 'update', { toolSlugs: [], integration: null })).toEqual([
      'tool-group-grant',
      'tool-config',
    ]);
  });
  it('one-spot tables: a turn-on, a resume, a new feed on, a group member', () => {
    expect(narrowSpotFor(skills, 'update', { enabled: true })).toEqual(['skill-text']);
    expect(narrowSpotFor(heartbeats, 'update', { status: 'active' })).toEqual(['heartbeat-maker']);
    expect(narrowSpotFor(calendarAccounts, 'insert', { ownerId: 'o', url: 'u' })).toEqual([
      'feed-enable',
    ]);
    expect(narrowSpotFor(agentGroups, 'update', { memberSlugs: [] })).toEqual([
      'agent-group-grant',
    ]);
    expect(narrowSpotFor(tools, 'update', { requiresConfirm: false })).toEqual(['tool-config']);
  });
  it('a table with no entry throws: its rules belong in NARROW_TABLE_SPOTS first', () => {
    expect(() => narrowSpotFor(nodes, 'update', { title: 't' })).toThrow(/no entry/);
  });
  it("every rule's spot and rest is in its table's spots list (the lint reads that list)", () => {
    for (const [t, e] of Object.entries(NARROW_TABLE_SPOTS)) {
      expect(e.spots, t).toContain(e.rest);
      for (const r of e.rules) expect(e.spots, t).toContain(r.spot);
    }
  });
});
