import { describe, it, expect } from 'vitest';
import { stageLabelForStep, thinkingPhrase, THINKING_PHRASES } from './stage-label';

describe('thinking-phrase rotation', () => {
  it('ships 20 distinct phrases, each ellipsis-terminated, "Thinking…" first', () => {
    expect(THINKING_PHRASES).toHaveLength(20);
    expect(THINKING_PHRASES[0]).toBe('Thinking…');
    expect(new Set(THINKING_PHRASES).size).toBe(20);
    expect(THINKING_PHRASES.every((p) => p.endsWith('…'))).toBe(true);
  });

  it('seeds deterministically and wraps around the list', () => {
    expect(thinkingPhrase(0)).toBe('Thinking…');
    expect(thinkingPhrase(3)).toBe(THINKING_PHRASES[3]);
    expect(thinkingPhrase(20)).toBe(THINKING_PHRASES[0]); // wraps
    expect(thinkingPhrase(23)).toBe(THINKING_PHRASES[3]);
    expect(thinkingPhrase()).toBe('Thinking…'); // unseeded default
  });

  it('varies the LLM-call label by the seed (the step seq)', () => {
    expect(stageLabelForStep('openrouter-chat_chat', undefined, 0)).toEqual({
      label: 'Thinking…',
      kind: 'thinking',
    });
    expect(stageLabelForStep('openrouter-chat_chat', undefined, 5)?.label).toBe(THINKING_PHRASES[5]);
    // Unseeded keeps the canonical line (the poll fallback path).
    expect(stageLabelForStep('anthropic-chat_chat[2]')?.label).toBe('Thinking…');
  });
});

describe('write/action tool labels', () => {
  it('names common write tools', () => {
    expect(stageLabelForStep('tool: note_create')?.label).toBe('Adding to your notes…');
    expect(stageLabelForStep('tool: event_delete')?.label).toBe('Removing an event…');
    expect(stageLabelForStep('tool: telegram_send')?.label).toBe('Sending a message…');
  });

  it('enriches a create with the subject title', () => {
    expect(
      stageLabelForStep('tool: note_create', { slug: 'note_create', args: { title: 'Q3 plan' } })?.label,
    ).toBe('Saving “Q3 plan” to your notes…');
  });

  it('guesses a verb for unknown tools', () => {
    expect(stageLabelForStep('tool: widget_update')?.label).toBe('Updating that…');
    expect(stageLabelForStep('tool: mystery_tool')?.label).toBe('Working on it…');
  });

  it('buckets each action under a fitting icon kind', () => {
    expect(stageLabelForStep('tool: note_create')?.kind).toBe('write');
    expect(stageLabelForStep('tool: task_update')?.kind).toBe('write');
    expect(stageLabelForStep('tool: event_create')?.kind).toBe('calendar');
    expect(stageLabelForStep('tool: telegram_send')?.kind).toBe('message');
    expect(stageLabelForStep('tool: email_get')?.kind).toBe('message');
    expect(stageLabelForStep('tool: file_upload')?.kind).toBe('file');
    expect(stageLabelForStep('tool: web_search')?.kind).toBe('web');
    expect(stageLabelForStep('tool: search_nodes')?.kind).toBe('brain');
    expect(stageLabelForStep('tool: mystery_tool')?.kind).toBe('tool');
  });
});
