/**
 * Tripwire: the persona bank EMITS the name token, this package RESOLVES it.
 *
 * The constant is declared twice on purpose — `@mantle/content` is a
 * browser-safe leaf and agent-runtime depends on it, so importing back would be
 * a cycle. Two literals with no test between them is how a silent drift ships:
 * the bank would emit `{{name}}` while the resolver looked for something else,
 * and every freshly onboarded assistant would introduce itself as a literal
 * template. This test is the only thing joining them.
 *
 * Same pattern as the app-bridge protocol / `@host` kit mirroring (kit.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { PERSONA_NAME_TOKEN, buildPersonaPrompt } from '@mantle/content';
import { AGENT_NAME_TOKEN, applyAgentName } from './skills';

describe('persona bank ⇄ name-token resolution', () => {
  it('declares the same literal on both sides', () => {
    expect(PERSONA_NAME_TOKEN).toBe(AGENT_NAME_TOKEN);
  });

  it('resolves a freshly built persona prompt end to end', () => {
    const built = buildPersonaPrompt('warm', { gender: 'female' });
    expect(built).toContain(AGENT_NAME_TOKEN);

    const resolved = applyAgentName(built, 'Tommy');
    expect(resolved).toContain('You are Tommy');
    // No token survives into what the model sees.
    expect(resolved).not.toContain(AGENT_NAME_TOKEN);
  });
});
