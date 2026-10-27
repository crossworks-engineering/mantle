/**
 * DWG bones phase 6, "same check for every author": the steps for a
 * circuit drawn from the uploaded P&IDs (trace, circuit_verify, trace
 * again, save) are ONE text (@mantle/tools circuit-trace/workflow.ts), and
 * every author reads it: the internal agents through their skills
 * (Draftsman: diagram_design; Presenter: canvas_authoring) and a client
 * over MCP in circuit_trace's result (`workflow`, which
 * packages/tools/src/circuit-parity.test.ts pins), pointed to by the
 * server instructions. The image check is a help, not a guarantee: the
 * steps say so in one line (IMAGE_CHECK_NOTE).
 */
import { describe, expect, it } from 'vitest';
import {
  CIRCUIT_DRAWING_STEPS,
  CIRCUIT_STEPS_POINTER,
  IMAGE_CHECK_NOTE,
  VERIFY_NEXT,
  VERIFY_ONCE,
} from '@mantle/tools/circuit-workflow';
import { MANTLE_MCP_INSTRUCTIONS, mcpInstructionsFor } from '@mantle/mcp-core';
import { MANIFEST_AGENTS } from './manifest';
import { SKILL_INSTRUCTIONS } from './prompts';

describe('the circuit drawing steps reach every author the same', () => {
  it('names the check between the trace and the save, and never spends on its own', () => {
    const order = ['circuit_trace', 'circuit_verify', 'present_create'].map((t) =>
      CIRCUIT_DRAWING_STEPS.indexOf(t),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(CIRCUIT_DRAWING_STEPS).toMatch(/never runs on its own/);
    // Only the trace writes the words; the check is a help, not a guarantee.
    expect(CIRCUIT_DRAWING_STEPS).toMatch(/Only circuit_trace writes GUESS/);
    expect(CIRCUIT_DRAWING_STEPS).toContain(IMAGE_CHECK_NOTE);
    expect(IMAGE_CHECK_NOTE).toBe(
      'Image checks help; they are not a guarantee. Verify on the drawing.',
    );
  });

  it('the agents that draw read it in their skills', () => {
    const skillOf = (slug: string) =>
      MANIFEST_AGENTS.find((a) => a.slug === slug)?.skillSlugs ?? [];
    expect(skillOf('diagrammer')).toContain('diagram_design');
    expect(skillOf('presenter')).toContain('canvas_authoring');
    for (const skill of ['diagram_design', 'canvas_authoring'])
      expect(SKILL_INSTRUCTIONS[skill], skill).toContain(CIRCUIT_DRAWING_STEPS);
  });

  it('a client over MCP is pointed to them by the server instructions, short', () => {
    // Loaded on every connection: the pointer, never the steps themselves
    // (circuit_trace's result carries them, `workflow`).
    for (const text of [MANTLE_MCP_INSTRUCTIONS, mcpInstructionsFor({} as never)]) {
      expect(text).toContain(CIRCUIT_STEPS_POINTER);
      expect(text).not.toContain(CIRCUIT_DRAWING_STEPS);
    }
    expect(CIRCUIT_STEPS_POINTER.length).toBeLessThan(300);
    for (const t of ['circuit_trace', 'circuit_verify', 'at most once per trace in a turn'])
      expect(CIRCUIT_STEPS_POINTER).toContain(t);
  });

  it('says circuit_verify runs at most once per trace in a turn, to every author', () => {
    expect(VERIFY_ONCE).toMatch(/at most once per trace in a turn/);
    expect(VERIFY_ONCE).toMatch(/never again in the same turn/);
    expect(VERIFY_ONCE).toMatch(/not_asked/);
    expect(CIRCUIT_DRAWING_STEPS).toContain(VERIFY_ONCE);
    for (const skill of ['diagram_design', 'canvas_authoring'])
      expect(SKILL_INSTRUCTIONS[skill], skill).toContain(VERIFY_ONCE);
    expect(MANTLE_MCP_INSTRUCTIONS).toMatch(/at most once per trace in a turn/);
    expect(VERIFY_NEXT).toContain(VERIFY_ONCE);
  });
});
