import { describe, expect, it } from 'vitest';
import { docLabelFromRelPath, prettifyDocLabel } from './docs-labels';

describe('prettifyDocLabel', () => {
  it('strips ordering prefixes and title-cases', () => {
    expect(prettifyDocLabel('00-index.md')).toBe('Index');
    expect(prettifyDocLabel('02-concepts')).toBe('Concepts');
    expect(prettifyDocLabel('the-brain.md')).toBe('The Brain');
  });

  it('keeps a version number whole (changelog entries)', () => {
    // Without the version guard the prefix strip would mangle these: `0.100.0` → "100.0".
    expect(prettifyDocLabel('0.100.0.md')).toBe('v0.100.0');
    expect(prettifyDocLabel('0.20.68.md')).toBe('v0.20.68');
    expect(prettifyDocLabel('v1.2.3.md')).toBe('v1.2.3');
  });

  it('does not treat prefixed doc names as versions', () => {
    expect(prettifyDocLabel('01-getting-started.md')).toBe('Getting Started');
  });
});

describe('docLabelFromRelPath', () => {
  it('labels from the last path segment', () => {
    expect(docLabelFromRelPath('guide/00-index.md')).toBe('Index');
    expect(docLabelFromRelPath('0.109.0.md')).toBe('v0.109.0');
  });
});
