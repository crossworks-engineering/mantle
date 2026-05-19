/**
 * Tests for the synthetic-prompt builders. These produce the strings
 * the LLM actually sees per fire, so any change risks behaviour drift
 * across all heartbeat skills. The contract is small: the prompt has
 * to surface the heartbeat's state, the skill's instructions, and a
 * pointer at the control tools.
 */

import { describe, expect, it } from 'vitest';
import type { Heartbeat, Skill } from '@mantle/db';
import { buildHeartbeatPrompt, buildOpenHeartbeatContext } from './prompt';

function mkHeartbeat(over: Partial<Heartbeat> = {}): Heartbeat {
  return {
    id: 'hb-uuid',
    ownerId: 'owner-uuid',
    slug: 'get_to_know_user',
    name: 'Get to know the user',
    description: null,
    agentSlug: 'saskia',
    skillSlug: 'profile_interview',
    scheduleKind: 'interval',
    schedule: { kind: 'interval', every_minutes: 1440 },
    nextFireAt: null,
    lastFiredAt: null,
    fireCount: 0,
    maxFires: null,
    surface: { kind: 'telegram', chat_id: '123' },
    minIdleMinutes: null,
    quietHours: null,
    earliestAt: null,
    cooldownMinutes: null,
    state: {},
    status: 'active',
    completionReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function mkSkill(over: Partial<Skill> = {}): Skill {
  return {
    id: 'skill-uuid',
    ownerId: 'owner-uuid',
    slug: 'profile_interview',
    name: 'Profile interview',
    description: 'Ask one question at a time',
    instructions: 'Ask one topic per fire. Set expecting_reply=true after asking.',
    toolSlugs: [],
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

describe('buildHeartbeatPrompt', () => {
  it('includes the heartbeat slug + name', () => {
    const out = buildHeartbeatPrompt({ hb: mkHeartbeat(), skill: mkSkill() });
    expect(out).toContain('get_to_know_user');
    expect(out).toContain('Get to know the user');
  });

  it('says "First fire" when lastFiredHuman is omitted', () => {
    const out = buildHeartbeatPrompt({ hb: mkHeartbeat(), skill: mkSkill() });
    expect(out).toContain('First fire');
  });

  it('formats fire number as fireCount + 1', () => {
    const out = buildHeartbeatPrompt({ hb: mkHeartbeat({ fireCount: 7 }), skill: mkSkill() });
    expect(out).toContain('Fire #8');
  });

  it('includes "of N" when maxFires is set', () => {
    const out = buildHeartbeatPrompt({
      hb: mkHeartbeat({ fireCount: 2, maxFires: 10 }),
      skill: mkSkill(),
    });
    expect(out).toContain('Fire #3 of 10');
  });

  it('includes lastFiredHuman when provided', () => {
    const out = buildHeartbeatPrompt({
      hb: mkHeartbeat({ fireCount: 3 }),
      skill: mkSkill(),
      lastFiredHuman: '2d ago',
    });
    expect(out).toContain('Last fired: 2d ago');
    expect(out).not.toContain('First fire');
  });

  it('renders the current state as pretty-printed JSON', () => {
    const out = buildHeartbeatPrompt({
      hb: mkHeartbeat({ state: { answered: ['family'], expecting_reply: false } }),
      skill: mkSkill(),
    });
    expect(out).toContain('"answered"');
    expect(out).toContain('"expecting_reply": false');
    expect(out).toContain('```json');
  });

  it('includes the skill instructions verbatim', () => {
    const inst = 'Ask about hobbies if family is already covered.';
    const out = buildHeartbeatPrompt({ hb: mkHeartbeat(), skill: mkSkill({ instructions: inst }) });
    expect(out).toContain(inst);
  });

  it('falls back when the skill has no instructions', () => {
    const out = buildHeartbeatPrompt({ hb: mkHeartbeat(), skill: mkSkill({ instructions: '' }) });
    expect(out).toContain('(skill has no instructions)');
  });

  it('mentions all three control tools by name', () => {
    const out = buildHeartbeatPrompt({ hb: mkHeartbeat(), skill: mkSkill() });
    expect(out).toContain('heartbeat_update_state');
    expect(out).toContain('heartbeat_snooze');
    expect(out).toContain('heartbeat_complete');
  });
});

describe('buildOpenHeartbeatContext', () => {
  it('returns an empty string when there are no open heartbeats', () => {
    expect(buildOpenHeartbeatContext([])).toBe('');
  });

  it('includes the section header when there is one', () => {
    const out = buildOpenHeartbeatContext([
      { slug: 'h1', name: 'One', state: { expecting_reply: true } },
    ]);
    expect(out).toContain('## Open heartbeats');
  });

  it('lists each open heartbeat with its state JSON', () => {
    const out = buildOpenHeartbeatContext([
      { slug: 'h1', name: 'One', state: { last_question_topic: 'family' } },
      { slug: 'h2', name: 'Two', state: { last_question_topic: 'work' } },
    ]);
    expect(out).toContain('h1');
    expect(out).toContain('h2');
    expect(out).toContain('family');
    expect(out).toContain('work');
  });

  it('mentions heartbeat_update_state (the next-action pointer)', () => {
    const out = buildOpenHeartbeatContext([
      { slug: 'h1', name: 'One', state: { expecting_reply: true } },
    ]);
    expect(out).toContain('heartbeat_update_state');
  });
});
