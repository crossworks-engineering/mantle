/**
 * Unit tests for sceneToText — the derived plaintext the brain reads for a
 * draw. Each test locks an invariant the extractor depends on: frames become
 * headings and group their members, shape labels surface once, bound arrows
 * render as relations, deleted elements vanish, and malformed input renders
 * to '' rather than throwing (the scene is client-supplied jsonb).
 */

import { describe, expect, it } from 'vitest';
import { sceneToText } from './scene-to-text';

const text = (id: string, t: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'text',
  text: t,
  ...extra,
});

const rect = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'rectangle',
  ...extra,
});

describe('sceneToText', () => {
  it('renders standalone text elements as lines', () => {
    const out = sceneToText({ elements: [text('a', 'Plan the ingest'), text('b', 'Ship it')] });
    expect(out).toBe('Plan the ingest\nShip it');
  });

  it('returns empty for empty/malformed scenes without throwing', () => {
    expect(sceneToText({ elements: [] })).toBe('');
    expect(sceneToText({})).toBe('');
    expect(sceneToText(null)).toBe('');
    expect(sceneToText('garbage')).toBe('');
    expect(sceneToText({ elements: [null, 42, 'x'] })).toBe('');
  });

  it('skips deleted elements', () => {
    const out = sceneToText({
      elements: [text('a', 'Keep'), text('b', 'Gone', { isDeleted: true })],
    });
    expect(out).toBe('Keep');
  });

  it('surfaces a container label once, via the shape', () => {
    const out = sceneToText({
      elements: [rect('r1'), text('t1', 'Server', { containerId: 'r1' })],
    });
    expect(out).toBe('Server');
  });

  it('renders a bound arrow between labelled shapes as a relation', () => {
    const out = sceneToText({
      elements: [
        rect('r1'),
        text('t1', 'Web', { containerId: 'r1' }),
        rect('r2'),
        text('t2', 'Postgres', { containerId: 'r2' }),
        {
          id: 'arr',
          type: 'arrow',
          startBinding: { elementId: 'r1' },
          endBinding: { elementId: 'r2' },
        },
      ],
    });
    expect(out).toContain('Web -> Postgres');
  });

  it('includes the arrow label in the relation', () => {
    const out = sceneToText({
      elements: [
        rect('r1'),
        text('t1', 'Web', { containerId: 'r1' }),
        rect('r2'),
        text('t2', 'Postgres', { containerId: 'r2' }),
        {
          id: 'arr',
          type: 'arrow',
          startBinding: { elementId: 'r1' },
          endBinding: { elementId: 'r2' },
        },
        text('t3', 'writes to', { containerId: 'arr' }),
      ],
    });
    expect(out).toContain('Web -> Postgres: writes to');
  });

  it('keeps the label of an unbound arrow', () => {
    const out = sceneToText({
      elements: [{ id: 'arr', type: 'arrow' }, text('t1', 'somewhere', { containerId: 'arr' })],
    });
    expect(out).toBe('somewhere');
  });

  it('an arrow bound to a standalone text uses that text as endpoint name', () => {
    const out = sceneToText({
      elements: [
        text('t1', 'Idea'),
        text('t2', 'Prototype'),
        {
          id: 'arr',
          type: 'arrow',
          startBinding: { elementId: 't1' },
          endBinding: { elementId: 't2' },
        },
      ],
    });
    expect(out).toContain('Idea -> Prototype');
  });

  it('groups member elements under their frame as a heading', () => {
    const out = sceneToText({
      elements: [
        { id: 'f1', type: 'frame', name: 'Phase 1' },
        text('t1', 'Migrations', { frameId: 'f1' }),
        text('t2', 'Loose note'),
      ],
    });
    expect(out).toBe('Loose note\n\n# Phase 1\nMigrations');
  });

  it('an element pointing at a nonexistent frame falls back to unframed', () => {
    const out = sceneToText({
      elements: [text('t1', 'Orphan', { frameId: 'ghost' })],
    });
    expect(out).toBe('Orphan');
  });

  it('an empty named frame still surfaces its name', () => {
    const out = sceneToText({ elements: [{ id: 'f1', type: 'frame', name: 'Later' }] });
    expect(out).toBe('# Later');
  });

  it('unlabelled shapes contribute nothing', () => {
    const out = sceneToText({ elements: [rect('r1'), { id: 'e1', type: 'ellipse' }] });
    expect(out).toBe('');
  });
});
