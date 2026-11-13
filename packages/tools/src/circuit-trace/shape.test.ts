/**
 * circuit_trace reads Segments, Nodes, Inserts and Texts by position, in the
 * order of the circuit-v1 shape (read.ts). A change of that order in
 * shapes.ts would read one column as another, so the order is pinned here.
 */
import { describe, expect, it } from 'vitest';
import { SHAPES } from '@mantle/files/shapes';

const tab = (name: string) => SHAPES['circuit-v1'].tabs.find((t) => t.name === name)!;

describe('the circuit-v1 order circuit_trace reads by position', () => {
  it('keeps the column order of each tab read by position', () => {
    expect(tab('Segments').neededColumns).toEqual([
      'Layer',
      'Handle',
      'X1',
      'Y1',
      'X2',
      'Y2',
      'Length',
      'Node 1',
      'Node 2',
    ]);
    expect(tab('Nodes').columns).toEqual([
      'Node',
      'X',
      'Y',
      'Degree',
      'Kind',
      'Block',
      'Block handle',
      'Layers',
    ]);
    expect(tab('Inserts').columns).toEqual([
      'Block',
      'Layer',
      'Handle',
      'X',
      'Y',
      'Min X',
      'Min Y',
      'Max X',
      'Max Y',
    ]);
    expect(tab('Texts').columns).toEqual(['Text', 'Layer', 'X', 'Y']);
  });
});
