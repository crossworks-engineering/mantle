import { describe, it, expect } from 'vitest';
import {
  diffConfig,
  countStatuses,
  type LiveConfig,
  type ManifestSlices,
  type EntityDiff,
} from './config-diff';
import type { ManifestAgent } from './manifest';

/**
 * The pure config diff engine. Uses a SYNTHETIC manifest (not the shipped one) so
 * the assertions stay deterministic regardless of what the real template ships.
 * The persona is slug `assistant` to match resolveEffectivePersona's canonical
 * slug (./persona.ts).
 */

const persona: ManifestAgent = {
  slug: 'assistant',
  name: 'Assistant',
  description: 'persona',
  role: 'responder',
  model: 'anthropic/claude-sonnet-4.6',
  isPersona: true,
  skillSlugs: ['tool_grounding', 'voice_reply'],
  toolGroupSlugs: ['memory-core', 'files'],
  params: { temperature: 0.7 },
  priority: 100,
};

const pages: ManifestAgent = {
  slug: 'pages',
  name: 'Pages',
  description: 'pages specialist',
  role: 'custom',
  model: 'anthropic/claude-sonnet-4.6',
  systemPrompt: 'PAGES PROMPT',
  skillSlugs: ['rich_writing', 'page_editing'],
  toolGroupSlugs: ['pages', 'files'],
  isDelegate: true,
  params: { temperature: 0.3 },
  priority: 100,
};

const MANIFEST: ManifestSlices = {
  agents: [persona, pages],
  skills: [
    { slug: 'tool_grounding', name: 'Tool grounding', description: '', instructions: 'GROUND' },
    { slug: 'voice_reply', name: 'Voice reply', description: '', instructions: 'VOICE' },
    { slug: 'rich_writing', name: 'Rich writing', description: '', instructions: 'RICH' },
    { slug: 'page_editing', name: 'Page editing', description: '', instructions: 'EDIT' },
  ],
  toolGroups: [
    {
      slug: 'memory-core',
      name: 'Memory core',
      description: '',
      toolSlugs: ['search', 'entity_search'],
    },
    { slug: 'files', name: 'Files', description: '', toolSlugs: ['file_list', 'file_read'] },
    { slug: 'pages', name: 'Pages', description: '', toolSlugs: ['page_create', 'page_update'] },
  ],
  workers: [
    {
      kind: 'extractor',
      name: 'Extractor',
      required: true,
      provider: 'openrouter',
      model: 'google/gemini-3.1-flash-lite',
    },
    {
      kind: 'tts',
      name: 'Voice',
      required: false,
      provider: 'openrouter',
      model: 'x-ai/grok-voice-tts-1.0',
      altProvider: 'xai',
      altModel: 'grok-voice-latest',
      altKeyService: 'xai',
    },
  ],
  delegateSlugs: ['pages'],
};

/** A fully in-sync brain: every live row matches the manifest exactly. */
function inSyncLive(): LiveConfig {
  return {
    agents: [
      {
        slug: 'assistant',
        name: 'Saskia',
        enabled: true,
        role: 'responder',
        priority: 100,
        skillSlugs: ['tool_grounding', 'voice_reply'],
        toolGroupSlugs: ['memory-core', 'files'],
        model: 'anthropic/claude-sonnet-4.6',
        systemPrompt: 'OPERATOR PERSONA PROMPT',
        memoryConfig: { delegate_to: ['pages'] },
      },
      {
        slug: 'pages',
        name: 'Pages',
        enabled: true,
        role: 'custom',
        priority: 100,
        skillSlugs: ['rich_writing', 'page_editing'],
        toolGroupSlugs: ['pages', 'files'],
        model: 'anthropic/claude-sonnet-4.6',
        systemPrompt: 'PAGES PROMPT',
        memoryConfig: {},
      },
    ],
    skills: [
      { slug: 'tool_grounding', name: 'Tool grounding', enabled: true, instructions: 'GROUND' },
      { slug: 'voice_reply', name: 'Voice reply', enabled: true, instructions: 'VOICE' },
      { slug: 'rich_writing', name: 'Rich writing', enabled: true, instructions: 'RICH' },
      { slug: 'page_editing', name: 'Page editing', enabled: true, instructions: 'EDIT' },
    ],
    toolGroups: [
      {
        slug: 'memory-core',
        name: 'Memory core',
        enabled: true,
        toolSlugs: ['search', 'entity_search'],
      },
      { slug: 'files', name: 'Files', enabled: true, toolSlugs: ['file_list', 'file_read'] },
      { slug: 'pages', name: 'Pages', enabled: true, toolSlugs: ['page_create', 'page_update'] },
    ],
    workers: [
      {
        kind: 'extractor',
        name: 'Extractor',
        enabled: true,
        isDefault: true,
        model: 'google/gemini-3.1-flash-lite',
      },
      {
        kind: 'tts',
        name: 'Voice',
        enabled: true,
        isDefault: true,
        model: 'x-ai/grok-voice-tts-1.0',
      },
    ],
  };
}

const find = (entities: EntityDiff[], kind: string, slug: string) =>
  entities.find((e) => e.kind === kind && e.slug === slug)!;

describe('diffConfig — in-sync brain', () => {
  it('reports every entity ok', () => {
    const entities = diffConfig(inSyncLive(), MANIFEST);
    expect(entities.every((e) => e.status === 'ok')).toBe(true);
    const counts = countStatuses(entities);
    expect(counts).toEqual({ ok: entities.length, missing: 0, extra: 0, modified: 0 });
  });

  it('does NOT diff the persona prompt or model (operator-owned)', () => {
    // Live persona has a different prompt + same structure → still ok.
    const live = inSyncLive();
    live.agents[0]!.systemPrompt = 'COMPLETELY DIFFERENT';
    live.agents[0]!.model = 'anthropic/claude-opus-4.8';
    const persona = find(diffConfig(live, MANIFEST), 'persona', 'assistant');
    expect(persona.status).toBe('ok');
    expect(persona.fields).toHaveLength(0);
  });
});

describe('diffConfig — persona structure', () => {
  it('flags missing + added tool groups via set-diff', () => {
    const live = inSyncLive();
    live.agents[0]!.toolGroupSlugs = ['memory-core', 'extra-custom']; // dropped 'files', added one
    const persona = find(diffConfig(live, MANIFEST), 'persona', 'assistant');
    expect(persona.status).toBe('modified');
    const groups = persona.fields.find((f) => f.field === 'toolGroupSlugs')!;
    expect(groups.removed).toEqual(['files']);
    expect(groups.added).toEqual(['extra-custom']);
  });

  it('flags a broken delegation wiring', () => {
    const live = inSyncLive();
    live.agents[0]!.memoryConfig = { delegate_to: [] };
    const persona = find(diffConfig(live, MANIFEST), 'persona', 'assistant');
    const deleg = persona.fields.find((f) => f.field === 'delegate_to')!;
    expect(deleg.removed).toEqual(['pages']);
  });

  it('surfaces a RETIRED default skill still attached (the rich_writing case) as modified + adoptable', () => {
    // Persona carries rich_writing, which the manifest no longer assigns to it.
    const live = inSyncLive();
    live.agents[0]!.skillSlugs = ['tool_grounding', 'voice_reply', 'rich_writing'];
    const persona = find(diffConfig(live, MANIFEST), 'persona', 'assistant');
    expect(persona.status).toBe('modified');
    const skills = persona.fields.find((f) => f.field === 'skillSlugs')!;
    expect(skills.added).toEqual(['rich_writing']); // live has it, template doesn't
    expect(skills.removed).toEqual([]);
    // Adopt-from-template is offered; adopting converges (detaches rich_writing).
    expect(persona.adoptable).toBe(true);
  });

  it('reports missing when there is no persona at all', () => {
    const live = inSyncLive();
    live.agents = live.agents.filter((a) => a.slug !== 'assistant'); // pages is role custom, not a responder
    const persona = find(diffConfig(live, MANIFEST), 'persona', 'assistant');
    expect(persona.status).toBe('missing');
    expect(persona.severity).toBe('high');
  });
});

describe('diffConfig — specialists', () => {
  it('reports a not-seeded specialist as missing/high', () => {
    const live = inSyncLive();
    live.agents = live.agents.filter((a) => a.slug !== 'pages');
    const e = find(diffConfig(live, MANIFEST), 'agent', 'pages');
    expect(e.status).toBe('missing');
    expect(e.severity).toBe('high');
  });

  it('reports a disabled specialist as missing', () => {
    const live = inSyncLive();
    live.agents[1]!.enabled = false;
    expect(find(diffConfig(live, MANIFEST), 'agent', 'pages').status).toBe('missing');
  });

  it('flags a missing skill link as modified/medium', () => {
    const live = inSyncLive();
    live.agents[1]!.skillSlugs = ['rich_writing']; // dropped page_editing
    const e = find(diffConfig(live, MANIFEST), 'agent', 'pages');
    expect(e.status).toBe('modified');
    expect(e.severity).toBe('medium');
    expect(e.fields.find((f) => f.field === 'skillSlugs')!.removed).toEqual(['page_editing']);
  });

  it('surfaces a specialist prompt drift as info-only (does not raise severity)', () => {
    const live = inSyncLive();
    live.agents[1]!.systemPrompt = 'EDITED PAGES PROMPT';
    const e = find(diffConfig(live, MANIFEST), 'agent', 'pages');
    expect(e.status).toBe('modified');
    expect(e.severity).toBe('low');
    expect(e.fields.find((f) => f.field === 'systemPrompt')!.info).toBe(true);
  });
});

describe('diffConfig — skills, tool groups, workers', () => {
  it('flags an edited skill body', () => {
    const live = inSyncLive();
    live.skills[0]!.instructions = 'OPERATOR EDIT';
    const e = find(diffConfig(live, MANIFEST), 'skill', 'tool_grounding');
    expect(e.status).toBe('modified');
    expect(e.fields[0]).toMatchObject({
      field: 'instructions',
      manifest: 'GROUND',
      live: 'OPERATOR EDIT',
    });
  });

  it('set-diffs tool group membership', () => {
    const live = inSyncLive();
    live.toolGroups[2]!.toolSlugs = ['page_create', 'page_delete']; // dropped page_update, added page_delete
    const e = find(diffConfig(live, MANIFEST), 'tool-group', 'pages');
    const f = e.fields.find((x) => x.field === 'toolSlugs')!;
    expect(f.removed).toEqual(['page_update']);
    expect(f.added).toEqual(['page_delete']);
  });

  it('a missing REQUIRED worker is high, a missing OPTIONAL worker is low', () => {
    const live = inSyncLive();
    live.workers = []; // both gone
    const entities = diffConfig(live, MANIFEST);
    expect(find(entities, 'worker', 'extractor')).toMatchObject({
      status: 'missing',
      severity: 'high',
    });
    expect(find(entities, 'worker', 'tts')).toMatchObject({ status: 'missing', severity: 'low' });
  });

  it('a worker present but not default counts as missing', () => {
    const live = inSyncLive();
    live.workers[0]!.isDefault = false;
    expect(find(diffConfig(live, MANIFEST), 'worker', 'extractor').status).toBe('missing');
  });

  it('a worker on its declared alt route (voice → xAI) is not drift', () => {
    const live = inSyncLive();
    live.workers[1]!.model = 'grok-voice-latest'; // the tts alt model
    expect(find(diffConfig(live, MANIFEST), 'worker', 'tts').status).toBe('ok');
  });
});

describe('diffConfig — adoptable flag', () => {
  it('marks missing + modified items adoptable, ok + extra not', () => {
    const live = inSyncLive();
    live.skills[0]!.instructions = 'EDITED'; // modified
    live.agents = live.agents.filter((a) => a.slug !== 'pages'); // pages missing
    live.toolGroups.push({ slug: 'mine', name: 'Mine', enabled: true, toolSlugs: [] }); // extra
    const entities = diffConfig(live, MANIFEST);
    expect(find(entities, 'skill', 'tool_grounding').adoptable).toBe(true); // modified
    expect(find(entities, 'agent', 'pages').adoptable).toBe(true); // missing
    expect(find(entities, 'skill', 'voice_reply').adoptable).toBe(false); // ok
    expect(find(entities, 'tool-group', 'mine').adoptable).toBe(false); // extra
  });
});

describe('diffConfig — operator extras', () => {
  it('reports operator-added agent / skill / tool group as extra', () => {
    const live = inSyncLive();
    live.agents.push({
      slug: 'my-agent',
      name: 'Mine',
      enabled: true,
      role: 'custom',
      priority: 50,
    });
    live.skills.push({ slug: 'my-skill', name: 'Mine', enabled: true, instructions: 'x' });
    live.toolGroups.push({ slug: 'my-group', name: 'Mine', enabled: true, toolSlugs: [] });
    const entities = diffConfig(live, MANIFEST);
    expect(find(entities, 'agent', 'my-agent').status).toBe('extra');
    expect(find(entities, 'skill', 'my-skill').status).toBe('extra');
    expect(find(entities, 'tool-group', 'my-group').status).toBe('extra');
  });
});
