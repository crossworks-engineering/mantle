import { describe, expect, it } from 'vitest';

import { markdownToDoc } from './markdown-to-doc';
import {
  RECALL_BODY_CHAR_BUDGET,
  assignRecallSlugs,
  parseRecallDoc,
  recallSlug,
} from './recall-compile';

// Docs are built through the real markdown→doc pipeline, so the parser is
// tested against exactly the node shapes the editor and MCP tools produce.

const INDEX_MD = `Use when: working on the Mantle fleet or its brains.

The registry index. Read the one you need.

## Options

- [Fleet access](page:aaa-fleet) — use when logging into a box
- [Architecture](mention:node:bbb-arch) — use when asking why a design is as it is
`;

describe('parseRecallDoc', () => {
  it('parses body, use-when, and both link forms of options', () => {
    const doc = markdownToDoc(INDEX_MD);
    const parsed = parseRecallDoc(doc);

    expect(parsed.issues).toEqual([]);
    expect(parsed.useWhen).toBe('working on the Mantle fleet or its brains.');
    expect(parsed.bodyMarkdown).toContain('The registry index');
    expect(parsed.bodyMarkdown).not.toContain('Options');
    expect(parsed.options).toEqual([
      { label: 'Fleet access', targetPageId: 'aaa-fleet', useWhen: 'use when logging into a box' },
      {
        label: 'Architecture',
        targetPageId: 'bbb-arch',
        useWhen: 'use when asking why a design is as it is',
      },
    ]);
  });

  it('flags an option without a use-when line', () => {
    const doc = markdownToDoc('Body.\n\n## Options\n\n- [Bare link](page:ccc)\n');
    const parsed = parseRecallDoc(doc);
    expect(parsed.options).toEqual([]);
    expect(parsed.issues).toEqual([
      expect.objectContaining({ severity: 'error', code: 'option-no-use-when' }),
    ]);
  });

  it('flags an option without any page target', () => {
    const doc = markdownToDoc('Body.\n\n## Options\n\n- just prose, no link anywhere\n');
    const parsed = parseRecallDoc(doc);
    expect(parsed.issues).toEqual([
      expect.objectContaining({ severity: 'error', code: 'option-no-target' }),
    ]);
  });

  it('flags a malformed Options section (content after the list)', () => {
    const doc = markdownToDoc(
      'Body.\n\n## Options\n\n- [A](page:aaa) — use when x\n\nTrailing prose.\n',
    );
    const parsed = parseRecallDoc(doc);
    expect(parsed.issues).toEqual([
      expect.objectContaining({ severity: 'error', code: 'options-shape' }),
    ]);
  });

  it('treats a doc with no Options heading as option-less, not broken', () => {
    const parsed = parseRecallDoc(markdownToDoc('Just knowledge, no options.'));
    expect(parsed.options).toBeNull();
    expect(parsed.issues).toEqual([]);
  });

  it('the LAST Options heading opens the section; earlier ones stay body', () => {
    const doc = markdownToDoc(
      '## Options\n\nProse about options in general.\n\n## Options\n\n- [A](page:aaa) — use when x\n',
    );
    const parsed = parseRecallDoc(doc);
    expect(parsed.issues).toEqual([]);
    expect(parsed.bodyMarkdown).toContain('Prose about options in general.');
    expect(parsed.options).toHaveLength(1);
  });

  it('requires a prompt to declare its use-when', () => {
    const parsed = parseRecallDoc(markdownToDoc('A prompt body with no declaration.'), {
      isPrompt: true,
    });
    expect(parsed.issues).toEqual([
      expect.objectContaining({ severity: 'error', code: 'prompt-no-use-when' }),
    ]);
  });

  it('accepts a prompt that opens with Use when', () => {
    const parsed = parseRecallDoc(
      markdownToDoc('Use when: drafting a jackdaw dialog.\n\nThe prompt body.'),
      { isPrompt: true },
    );
    expect(parsed.issues).toEqual([]);
    expect(parsed.useWhen).toBe('drafting a jackdaw dialog.');
  });

  it('enforces the character budget on the rendered body', () => {
    const parsed = parseRecallDoc(markdownToDoc('x'.repeat(200)), { bodyCharBudget: 100 });
    expect(parsed.issues).toEqual([
      expect.objectContaining({ severity: 'error', code: 'body-over-budget' }),
    ]);
    expect(RECALL_BODY_CHAR_BUDGET).toBeGreaterThan(1000);
  });
});

describe('slugs', () => {
  it('kebab-cases titles', () => {
    expect(recallSlug('Fleet, access & the MCP brains')).toBe('fleet-access-the-mcp-brains');
    expect(recallSlug('  ')).toBe('node');
  });

  it('dedupes collisions stably in order', () => {
    const slugs = assignRecallSlugs([
      { id: '1', title: 'Setup' },
      { id: '2', title: 'Setup' },
      { id: '3', title: 'Setup' },
    ]);
    expect(slugs.get('1')).toBe('setup');
    expect(slugs.get('2')).toBe('setup-2');
    expect(slugs.get('3')).toBe('setup-3');
  });
});
