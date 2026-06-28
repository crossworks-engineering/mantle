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

  it('names write/action tools so the trail reflects what changed', () => {
    expect(stageLabelForStep('tool: note_create')).toBe('Adding to your notes…');
    expect(stageLabelForStep('tool: task_create')).toBe('Adding a task…');
    expect(stageLabelForStep('tool: event_create')).toBe('Adding to your calendar…');
    expect(stageLabelForStep('tool: note_update')).toBe('Updating a note…');
    expect(stageLabelForStep('tool: email_send')).toBe('Sending an email…');
    expect(stageLabelForStep('tool: file_upload')).toBe('Saving a file…');
  });

  it('enriches a create with the subject title when present', () => {
    expect(
      stageLabelForStep('tool: note_create', { slug: 'note_create', args: { title: 'Q3 plan' } }),
    ).toBe('Saving “Q3 plan” to your notes…');
  });

  it('falls back to a verb guess for unknown tools, generic for spill', () => {
    expect(stageLabelForStep('tool: widget_delete')).toBe('Removing that…');
    expect(stageLabelForStep('tool: gizmo_send')).toBe('Sending that…');
    expect(stageLabelForStep('tool: mystery_tool')).toBe('Working on it…');
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

  it('enriches the label with a safe query arg when present', () => {
    expect(stageLabelForStep('tool: web_search', { query: 'Pinnacle SLA' })).toBe(
      'Searching the web for “Pinnacle SLA”…',
    );
    expect(stageLabelForStep('tool: search_nodes', { q: 'invoice' })).toBe(
      'Searching your brain for “invoice”…',
    );
    expect(stageLabelForStep('tool: invoke_agent', { agent: 'Researcher' })).toBe(
      'Delegating to Researcher…',
    );
  });

  it('reads args from the real nested step-input shape `{ slug, args }`', () => {
    // The tool loop logs input as { slug, args: {...} } — enrichment must look
    // under `args`, not the top level. (Regression: brain search showed the bare
    // bucket label because `q` lived at input.args.q.)
    expect(
      stageLabelForStep('tool: search_nodes', { slug: 'search_nodes', args: { q: 'streaming', limit: 20 } }),
    ).toBe('Searching your brain for “streaming”…');
    expect(
      stageLabelForStep('tool: invoke_agent', { slug: 'invoke_agent', args: { agent: 'Researcher' } }),
    ).toBe('Delegating to Researcher…');
  });

  it('never echoes a secret-looking arg into the label', () => {
    // No safe query key present → falls back to the bucket label, not the token.
    expect(stageLabelForStep('tool: web_search', { api_key: 'sk-deadbeef' })).toBe(
      'Searching the web…',
    );
    expect(stageLabelForStep('tool: search_nodes', { authToken: 'secret' })).toBe(
      'Searching your brain…',
    );
  });

  it('caps an over-long query arg', () => {
    const long = 'x'.repeat(80);
    const label = stageLabelForStep('tool: web_search', { query: long });
    expect(label).toContain('…');
    expect(label!.length).toBeLessThan(80);
  });
});
