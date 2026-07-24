import { describe, it, expect } from 'vitest';
import { specialistStageLabelForStep } from './assist-stage';

/**
 * The labels depend on the step-name contract from the tool loop
 * (`<adapter>_chat`, `tool: <slug>`). There's no compile-time link to those
 * names, so assert a representative slug per specialist maps — if tool-loop's
 * naming or a tool slug changes, this fails instead of silently degrading to
 * the "{name} is working…" fallback.
 */
describe('specialistStageLabelForStep', () => {
  it('maps LLM-call steps to Thinking…', () => {
    expect(specialistStageLabelForStep('openai_chat')).toBe('Thinking…');
    expect(specialistStageLabelForStep('anthropic_chat[2]')).toBe('Thinking…');
  });

  it('maps base tool steps shared across specialists', () => {
    expect(specialistStageLabelForStep('tool: invoke_agent')).toBe('Delegating…');
    expect(specialistStageLabelForStep('tool: web_fetch')).toBe('Reading docs…');
  });

  it('maps a representative slug per specialist', () => {
    expect(specialistStageLabelForStep('tool: app_build')).toBe('Building…');
    expect(specialistStageLabelForStep('tool: page_block_update')).toBe('Editing the page…');
    expect(specialistStageLabelForStep('tool: table_commit')).toBe('Saving…');
    expect(specialistStageLabelForStep('tool: api_tool_test')).toBe('Testing the API…');
  });

  it('falls back to a generic label for unrecognised tools, null otherwise', () => {
    expect(specialistStageLabelForStep('tool: something_new')).toBe('Working on it…');
    expect(specialistStageLabelForStep('')).toBeNull();
    expect(specialistStageLabelForStep('mystery_step')).toBeNull();
  });
});
