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
      { node: 'R', label: 'Route to reviewer,<br/>deputy approver (backup),<br/>Records Office' },
    ]);
  });

  it('passes the quoted fix', () => {
    expect(
      mermaidLabelProblems(fence('flowchart TD\n    I --> R["deputy approver (backup)"]')),
    ).toEqual([]);
  });

  it('flags a diamond label too', () => {
    expect(
      mermaidLabelProblems(fence('flowchart TD\n    A --> B{Is it step 2 (revised)?}')),
    ).toEqual([{ node: 'B', label: 'Is it step 2 (revised)?' }]);
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
