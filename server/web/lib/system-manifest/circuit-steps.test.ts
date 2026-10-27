/**
 * DWG bones phase 6, "same check for every author": the steps for a
 * circuit drawn from the uploaded P&IDs (trace, circuit_verify, trace
 * again, save) are ONE text (@mantle/tools circuit-trace/workflow.ts), and
 * every author reads it: the internal agents through their skills
 * (Draftsman: diagram_design; Presenter: canvas_authoring) and a client
 * over MCP in circuit_trace's result (`workflow`, which
 * packages/tools/src/circuit-parity.test.ts pins), pointed to by the
 * server instructions. The unchecked-guess count is the tools' own (the
 * same test).
 */
import { describe, expect, it } from 'vitest';
import {
  CIRCUIT_DRAWING_STEPS,
  CIRCUIT_STEPS_POINTER,
  imageCheckReport,
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
    expect(CIRCUIT_DRAWING_STEPS).toMatch(/image_check/);
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
    // The rule (owner, 2026-10-26: every drawing goes through the image
    // check, but never a loop of calls on the owner's key).
    expect(VERIFY_ONCE).toMatch(/at most once per trace in a turn/);
    expect(VERIFY_ONCE).toMatch(/never again in the same turn/);
    expect(VERIFY_ONCE).toMatch(/not_asked/);
    expect(VERIFY_ONCE).toMatch(/save the drawing and report how many are unchecked/);
    // In the steps, so in both skills and circuit_trace's result; the MCP
    // server instructions' pointer says it in short.
    expect(CIRCUIT_DRAWING_STEPS).toContain(VERIFY_ONCE);
    for (const skill of ['diagram_design', 'canvas_authoring'])
      expect(SKILL_INSTRUCTIONS[skill], skill).toContain(VERIFY_ONCE);
    expect(MANTLE_MCP_INSTRUCTIONS).toMatch(/at most once per trace in a turn/);
    // And in the hints a result carries after a trace or a check.
    expect(VERIFY_NEXT).toContain(VERIFY_ONCE);
    const unchecked = imageCheckReport({
      guesses: 3,
      unchecked: 2,
      checked: 1,
      unsure: 0,
      contradicted: 0,
      corrected: 0,
    });
    expect(unchecked?.next).toContain(VERIFY_ONCE);
  });
});
