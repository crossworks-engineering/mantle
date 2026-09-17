import { describe, it, expect } from 'vitest';
import {
  cloneAgentFields,
  slugifyAgentName,
  tokeniseSourceName,
  uniqueAgentSlug,
} from './agent-clone';
import { AGENT_NAME_TOKEN } from '@mantle/runtime/agent';
import type { AgentDTO } from '@mantle/client-types';

/**
 * Per-login assistants (migration 0143). These pin the two decisions that are
 * easy to get quietly wrong: which fields a clone inherits, and where it sits in
 * the priority order that headless callers resolve against.
 */

const source = (over: Partial<AgentDTO> = {}): AgentDTO => ({
  id: 'src-id',
  slug: 'assistant',
  name: 'Saskia',
  description: 'The brain persona.',
  role: 'responder',
  provider: 'openrouter',
  model: 'anthropic/claude-sonnet-5',
  apiKeyId: 'key-1',
  backupProvider: 'lmstudio',
  backupModel: 'gemma-4',
  backupApiKeyId: 'key-2',
  backupEnabled: true,
  baseUrl: 'http://box:1234/v1',
  viaTailnet: true,
  backupBaseUrl: null,
  backupViaTailnet: false,
  ttsWorkerId: 'tts-1',
  systemPrompt: 'You are helpful.',
  skillSlugs: ['tool_grounding', 'voice_reply'],
  toolGroupSlugs: ['core', 'research'],
  memoryConfig: { history_limit: 20, delegate_to: ['researcher', 'remy'] },
  params: { temperature: 0.7 },
  avatar: { style: 'beam', seed: 'saskia' },
  personaNotes: [{ kind: 'style', content: 'Keep it short.', at: '2026-01-01T00:00:00.000Z' }],
  assignedUserId: null,
  assignedAt: null,
  priority: 100,
  enabled: true,
  manifestManaged: false,
  lastUsedAt: null,
  usageCount: 42,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const identity = { name: 'Nova', slug: 'nova', assignedUserEmail: 'sam@example.com' };

describe('slugifyAgentName', () => {
  it('kebab-cases to the [a-z0-9-] the slug column allows', () => {
    expect(slugifyAgentName('Nova')).toBe('nova');
    expect(slugifyAgentName("Sam's Helper!")).toBe('sam-s-helper');
    expect(slugifyAgentName('  spaced   out  ')).toBe('spaced-out');
  });

  it('folds accents rather than splitting the word', () => {
    expect(slugifyAgentName('Renée')).toBe('renee');
  });

  it('returns empty for a name with nothing usable', () => {
    expect(slugifyAgentName('🙂 —')).toBe('');
  });
});

describe('uniqueAgentSlug', () => {
  it('takes the base when it is free', () => {
    expect(uniqueAgentSlug('nova', ['assistant', 'remy'])).toBe('nova');
  });

  it('walks the -2/-3 series past collisions', () => {
    expect(uniqueAgentSlug('nova', ['nova'])).toBe('nova-2');
    expect(uniqueAgentSlug('nova', ['nova', 'nova-2', 'nova-3'])).toBe('nova-4');
  });

  it('falls back to `assistant` for an empty base, then uniquifies that', () => {
    expect(uniqueAgentSlug('', [])).toBe('assistant');
    expect(uniqueAgentSlug('', ['assistant'])).toBe('assistant-2');
  });
});

describe('cloneAgentFields', () => {
  it('carries the whole route, prompt, skills and tools across', () => {
    const s = source();
    const clone = cloneAgentFields(s, identity);
    expect(clone).toMatchObject({
      role: s.role,
      provider: s.provider,
      model: s.model,
      apiKeyId: s.apiKeyId,
      backupProvider: s.backupProvider,
      backupModel: s.backupModel,
      backupApiKeyId: s.backupApiKeyId,
      backupEnabled: true,
      baseUrl: s.baseUrl,
      viaTailnet: true,
      ttsWorkerId: s.ttsWorkerId,
      systemPrompt: s.systemPrompt,
      skillSlugs: s.skillSlugs,
      toolGroupSlugs: s.toolGroupSlugs,
      params: s.params,
      avatar: s.avatar,
      enabled: true,
    });
  });

  it('keeps delegate_to so the clone can reach shared specialists on day one', () => {
    const clone = cloneAgentFields(source(), identity);
    expect(clone.memoryConfig?.delegate_to).toEqual(['researcher', 'remy']);
    expect(clone.memoryConfig?.history_limit).toBe(20);
  });

  it('does not copy persona notes — they are about the OTHER person', () => {
    const clone = cloneAgentFields(source(), identity);
    // CreateAgentInput has no personaNotes field at all; the column defaults to
    // []. Assert the absence so re-adding it has to be deliberate.
    expect('personaNotes' in clone).toBe(false);
  });

  it('ranks below its source so it never becomes the headless default', () => {
    expect(cloneAgentFields(source({ priority: 100 }), identity).priority).toBe(99);
    // pickWebDefaultAgent breaks ties on slug, so an EQUAL priority would let a
    // clone outrank the persona for the reminders worker and heartbeats.
    expect(cloneAgentFields(source({ priority: 0 }), identity).priority).toBe(0);
  });

  it('takes its identity from the caller, not the source', () => {
    const clone = cloneAgentFields(source(), identity);
    expect(clone.slug).toBe('nova');
    expect(clone.name).toBe('Nova');
    expect(clone.description).toContain('sam@example.com');
  });

  it('copies collections rather than aliasing the source arrays', () => {
    const s = source();
    const clone = cloneAgentFields(s, identity);
    clone.skillSlugs?.push('extra');
    expect(s.skillSlugs).toEqual(['tool_grounding', 'voice_reply']);
  });
});

/**
 * The clone used to answer as the agent it was copied from — live at v0.220.0,
 * where an assistant named Tommy opened with "You are Mira — an RBI specialist".
 */
describe('tokeniseSourceName', () => {
  it("replaces the source's name with the token", () => {
    expect(tokeniseSourceName('You are Mira — an RBI specialist.', 'Mira')).toBe(
      `You are ${AGENT_NAME_TOKEN} — an RBI specialist.`,
    );
  });

  it('replaces every occurrence', () => {
    const out = tokeniseSourceName('You are Saskia. Be Saskia.', 'Saskia');
    expect(out).toBe(`You are ${AGENT_NAME_TOKEN}. Be ${AGENT_NAME_TOKEN}.`);
  });

  it('matches whole words only — "Max" must not corrupt "maximum"', () => {
    const out = tokeniseSourceName('You are Max. Give maximum effort, Max.', 'Max');
    expect(out).toBe(`You are ${AGENT_NAME_TOKEN}. Give maximum effort, ${AGENT_NAME_TOKEN}.`);
  });

  it('matches at punctuation boundaries, not just spaces', () => {
    const out = tokeniseSourceName('(Mira) said "Mira", then Mira.', 'Mira');
    expect(out).toBe(`(${AGENT_NAME_TOKEN}) said "${AGENT_NAME_TOKEN}", then ${AGENT_NAME_TOKEN}.`);
  });

  it('is case-sensitive — a name is a proper noun', () => {
    // "Iris" the assistant vs "iris" the flower: lowercase prose is far more
    // likely an unrelated word than a reference to the agent.
    expect(tokeniseSourceName('You are Iris. The iris opened.', 'Iris')).toBe(
      `You are ${AGENT_NAME_TOKEN}. The iris opened.`,
    );
  });

  it('treats an operator name with regex metacharacters as literal text', () => {
    expect(tokeniseSourceName('You are C++ here.', 'C++')).toBe(
      `You are ${AGENT_NAME_TOKEN} here.`,
    );
  });

  it('leaves a prompt that never names itself untouched', () => {
    const prompt = 'You are a helpful assistant.';
    expect(tokeniseSourceName(prompt, 'Mira')).toBe(prompt);
    expect(tokeniseSourceName(prompt, '   ')).toBe(prompt);
  });

  it('leaves an already-tokenised prompt alone', () => {
    // A persona-bank prompt is name-agnostic already; cloning must be a no-op.
    const prompt = `You are ${AGENT_NAME_TOKEN} — warm and grounded.`;
    expect(tokeniseSourceName(prompt, 'Saskia')).toBe(prompt);
  });
});

describe('cloneAgentFields — identity', () => {
  it("hands the clone a name-agnostic prompt, not the source's identity", () => {
    const s = source({ name: 'Mira', systemPrompt: 'You are Mira — an RBI specialist.' });
    const clone = cloneAgentFields(s, identity);
    expect(clone.systemPrompt).toBe(`You are ${AGENT_NAME_TOKEN} — an RBI specialist.`);
    // The domain expertise is the whole reason to clone rather than regenerate.
    expect(clone.systemPrompt).toContain('RBI specialist');
    expect(clone.systemPrompt).not.toContain('Mira');
  });
});
