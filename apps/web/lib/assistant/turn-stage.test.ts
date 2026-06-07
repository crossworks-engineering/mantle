import { describe, it, expect } from 'vitest';
import { stageLabelForStep } from './turn-stage';

describe('stageLabelForStep', () => {
  it('maps LLM-call step names to Thinking', () => {
    expect(stageLabelForStep('openrouter-chat_chat')).toBe('Thinking…');
    expect(stageLabelForStep('openrouter-chat_chat[2]')).toBe('Thinking…');
    expect(stageLabelForStep('anthropic-chat_chat[force_final]')).toBe('Thinking…');
  });

  it('maps tool dispatch names to the right bucket', () => {
    expect(stageLabelForStep('tool: invoke_agent')).toBe('Delegating to a specialist…');
    expect(stageLabelForStep('tool: web_search')).toBe('Searching the web…');
    expect(stageLabelForStep('tool: search_nodes')).toBe('Searching your brain…');
    expect(stageLabelForStep('tool: find_window')).toBe('Searching your brain…');
    expect(stageLabelForStep('tool: recall_window')).toBe('Searching your brain…');
    expect(stageLabelForStep('tool: entity_facts')).toBe('Searching your brain…');
  });

  it('buckets other tools as a generic working label', () => {
    expect(stageLabelForStep('tool: note_create')).toBe('Working on it…');
    expect(stageLabelForStep('tool: email_send')).toBe('Working on it…');
    expect(stageLabelForStep('spill_result: web_search')).toBe('Working on it…');
  });

  it('does not mistake web_search for a brain search', () => {
    // web_search must win over the search* brain prefix.
    expect(stageLabelForStep('tool: web_search')).toBe('Searching the web…');
  });

  it('returns null for unrecognised / empty names (caller shows plain dots)', () => {
    expect(stageLabelForStep('')).toBeNull();
    expect(stageLabelForStep('extract_attachment')).toBeNull();
    expect(stageLabelForStep('some_other_step')).toBeNull();
  });
});
