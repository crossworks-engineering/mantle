import { describe, expect, it } from 'vitest';
import { mermaidLabelProblems } from './mermaid-lint';

const fence = (body: string) => '```mermaid\n' + body + '\n```';

describe('mermaidLabelProblems', () => {
  it('flags the label shape that shipped a broken diagram to a reader', () => {
    // A multi-line label carrying a parenthesised clause: mermaid reads the `(`
    // as a round-node shape and the WHOLE flowchart fails to parse.
    const problems = mermaidLabelProblems(
      fence(
        'flowchart TD\n' +
          '    I --> R[Route to reviewer,<br/>deputy approver (backup),<br/>Records Office]',
      ),
    );
    expect(problems).toEqual([
      {
        node: 'R',
        label: 'Route to reviewer,<br/>deputy approver (backup),<br/>Records Office',
        open: '[',
        close: ']',
      },
    ]);
  });

  it('passes the quoted fix', () => {
    expect(
      mermaidLabelProblems(fence('flowchart TD\n    I --> R["deputy approver (backup)"]')),
    ).toEqual([]);
  });

  it('flags a diamond label too, and reports the diamond BRACKETS', () => {
    // The teaching error renders the label back in the node's own shape — a
    // `{diamond}` echoed as `[a box]` invites the agent to change the shape.
    expect(
      mermaidLabelProblems(fence('flowchart TD\n    A --> B{Is it step 2 (revised)?}')),
    ).toEqual([{ node: 'B', label: 'Is it step 2 (revised)?', open: '{', close: '}' }]);
  });

  it('flags a fence whose info string carries extra words (```mermaid title=x)', () => {
    // markdown-to-doc classifies a fence by the FIRST word of its info string,
    // so this IS a diagram node — the first version of this lint anchored the
    // regex at end-of-line and let exactly this form ship broken.
    expect(
      mermaidLabelProblems('```mermaid title=Approval flow\nflowchart TD\n  A[x (y)]\n```'),
    ).toEqual([{ node: 'A', label: 'x (y)', open: '[', close: ']' }]);
  });

  it('does not treat ```mermaidjs (or other prefixed languages) as mermaid', () => {
    expect(mermaidLabelProblems('```mermaidjs\nflowchart TD\n  A[x (y)]\n```')).toEqual([]);
  });

  it('never scans a mermaid example nested inside another fence', () => {
    // A ````md documentation block SHOWING the broken form: marked lexes the
    // outer fence as one code block (no diagram node is born), so linting the
    // inner text would refuse a legitimate page write — unfixably, since
    // quoting the label would destroy the example.
    expect(mermaidLabelProblems('````md\n```mermaid\nflowchart TD\n  A[x (y)]\n```\n````')).toEqual(
      [],
    );
    // Same via a bare ``` fence.
    expect(mermaidLabelProblems('```\n```mermaid\nflowchart TD\n  A[x (y)]\n```')).toEqual([]);
  });

  it('lints an UNCLOSED mermaid fence to end of input, like the parser', () => {
    expect(mermaidLabelProblems('```mermaid\nflowchart TD\n  A[x (y)]')).toHaveLength(1);
  });

  it('requires the closer to be at least as long as the opener', () => {
    // ````mermaid … ``` … ```` — the 3-tick line is body, not a closer.
    expect(
      mermaidLabelProblems('````mermaid\nflowchart TD\n  A[x (y)]\n```\n  B[z (w)]\n````'),
    ).toHaveLength(2);
  });

  it('skips bodies larger than the lint cap instead of stalling', () => {
    // Best-effort: a huge body (here: many unclosed-opener lines, the regex
    // version's quadratic worst case) returns [] fast rather than blocking the
    // tool loop. The render side still reports its own error.
    const big = ('```mermaid\n' + 'flowchart TD\n  A[x (y)]\n').repeat(4000);
    const t0 = Date.now();
    expect(mermaidLabelProblems(big)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it('leaves clean labels alone', () => {
    // Colons, slashes, en/em dashes, <br/> and ≠ are all fine unquoted — only
    // the bracket family breaks the parser.
    expect(
      mermaidLabelProblems(
        fence(
          'flowchart TD\n' +
            '    A[Trigger Occurs] --> B{What kind of trigger?}\n' +
            '    B -->|Finding / loss| C[Case 2:<br/>Findings ≠ Predictions]\n' +
            '    B -->|Change / repair| D[Cases 3, 4, 5.1–5.7]\n' +
            '    N[Log and close — no further action]\n' +
            '    P[Route for approval:<br/>Reviewer / Inspector]',
        ),
      ),
    ).toEqual([]);
  });

  it('skips the other node shapes, whose bodies legitimately open with a delimiter', () => {
    expect(
      mermaidLabelProblems(
        fence(
          'flowchart LR\n' +
            '    A[[Subroutine (x)]]\n' +
            '    B[(Database (main))]\n' +
            '    C[/Parallelogram (in)/]\n' +
            '    D[\\Trapezoid (alt)\\]',
        ),
      ),
    ).toEqual([]);
  });

  it('ignores comment lines', () => {
    expect(
      mermaidLabelProblems(
        fence('flowchart TD\n    %% note: A[Legacy (old)] was removed\n    A --> B'),
      ),
    ).toEqual([]);
  });

  it('only lints flowcharts — other diagram types reuse the brackets', () => {
    expect(
      mermaidLabelProblems(fence('sequenceDiagram\n    Alice->>Bob: check note[step 2 (b)] first')),
    ).toEqual([]);
  });

  it('ignores prose outside a mermaid fence', () => {
    expect(mermaidLabelProblems('See the deputy approver[note (here)] in the procedure.')).toEqual(
      [],
    );
  });

  it('handles a tilde fence and an indented fence', () => {
    expect(mermaidLabelProblems('~~~mermaid\nflowchart TD\n  A[x (y)]\n~~~')).toHaveLength(1);
    expect(mermaidLabelProblems('  ```mermaid\n  flowchart TD\n    A[x (y)]\n  ```')).toHaveLength(
      1,
    );
  });

  it('does not close a backtick fence with tildes (or vice versa)', () => {
    expect(mermaidLabelProblems('```mermaid\nflowchart TD\n~~~\n  A[x (y)]\n```')).toHaveLength(1);
  });

  it('reports each distinct bad label once, across multiple fences', () => {
    const body =
      fence('flowchart TD\n  A[one (1)]\n  A[one (1)]\n  B[two (2)]') +
      '\n\ntext\n\n' +
      fence('flowchart TD\n  C[three (3)]');
    expect(mermaidLabelProblems(body).map((p) => p.node)).toEqual(['A', 'B', 'C']);
  });

  it('is a no-op on empty and diagram-free input', () => {
    expect(mermaidLabelProblems('')).toEqual([]);
    expect(mermaidLabelProblems(null)).toEqual([]);
    expect(mermaidLabelProblems('# Just a heading\n\nSome (parenthesised) prose.')).toEqual([]);
  });
});
