import { describe, it, expect } from 'vitest';
import { stageLabelForStep, THINKING_LABEL } from './stage-label';

describe('thinking label', () => {
  it('is a single honest line (canned rotation retired)', () => {
    expect(THINKING_LABEL).toBe('Thinking…');
  });

  it('labels every LLM-call step "Thinking…", regardless of seed', () => {
    expect(stageLabelForStep('openrouter-chat_chat', undefined, 0)).toEqual({
      label: 'Thinking…',
      kind: 'thinking',
    });
    // The seed no longer rotates the phrase — same line on every round.
    expect(stageLabelForStep('openrouter-chat_chat', undefined, 5)?.label).toBe('Thinking…');
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
      stageLabelForStep('tool: note_create', { slug: 'note_create', args: { title: 'Q3 plan' } })
        ?.label,
    ).toBe('Saving “Q3 plan” to your notes…');
  });

  it('labels draft commits/discards — no verb pattern matches them, and the dock is now the only stage surface', () => {
    // These moved here when the per-surface assist panels (and their own
    // stage endpoint) were removed: the responder can call page_commit itself
    // since v0.206, so the moment content becomes visible deserves better
    // than the "Working on it…" fallback.
    expect(stageLabelForStep('tool: page_commit')?.label).toBe('Publishing the page…');
    expect(stageLabelForStep('tool: page_discard_draft')?.label).toBe('Discarding the draft…');
    expect(stageLabelForStep('tool: table_commit')?.label).toBe('Publishing the table…');
  });

  it('guesses a verb for unknown tools, naming the tool noun (never a bare "that")', () => {
    expect(stageLabelForStep('tool: widget_update')?.label).toBe('Updating widget…');
    expect(stageLabelForStep('tool: mystery_tool')?.label).toBe('Using mystery tool…');
    // A safe subject enriches the fallback the same way it does mapped tools.
    expect(
      stageLabelForStep('tool: widget_update', {
        slug: 'widget_update',
        args: { title: 'Pump P-101' },
      })?.label,
    ).toBe('Updating widget “Pump P-101”…');
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
