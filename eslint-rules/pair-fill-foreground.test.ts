import { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain-JS rule module, no types shipped.
import { findMismatches, rule } from './pair-fill-foreground.mjs';

/**
 * The rule's whole value is its PRECISION. A pairing rule that fires on the
 * codebase's dominant correct idiom would be turned off within a day, so the
 * "valid" cases below matter at least as much as the invalid ones — most of
 * them are real class strings lifted out of the repo.
 */
describe('findMismatches', () => {
  const flags = (s: string) =>
    findMismatches(s).map((m: { fill: string; ink: string }) => `${m.fill}/${m.ink}`);

  it('accepts the dominant correct idiom: muted base, re-paired on hover', () => {
    // This is what most interactive elements in the app look like. The muted
    // ink applies on the page background; the hover state changes BOTH tokens.
    expect(flags('text-muted-foreground hover:bg-accent hover:text-accent-foreground')).toEqual([]);
  });

  it('accepts a fill paired with its own foreground', () => {
    expect(flags('bg-primary text-primary-foreground')).toEqual([]);
    expect(
      flags('data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground'),
    ).toEqual([]);
  });

  it('accepts text-foreground on any fill — the strongest ink is never the bug', () => {
    expect(flags('hover:bg-accent hover:text-foreground')).toEqual([]);
  });

  it('ignores plain surfaces, which legitimately take either ink', () => {
    expect(flags('bg-card text-muted-foreground')).toEqual([]);
    expect(flags('bg-muted text-muted-foreground')).toEqual([]);
  });

  it('ignores tinted fills — a 5% wash is a different surface', () => {
    expect(flags('bg-destructive/5 text-muted-foreground')).toEqual([]);
    expect(flags('hover:bg-accent/60 text-muted-foreground')).toEqual([]);
  });

  it('ignores inks it cannot reason about', () => {
    expect(flags('bg-accent text-white')).toEqual([]);
    expect(flags('bg-accent')).toEqual([]);
  });

  it('catches the shape that actually shipped: muted ink on an accent fill', () => {
    // v0.205.7 (slash-menu, mention-list) and v0.206.1 (CommandItem, ⌘K
    // palette + 4 more). Found by a user, not by CI.
    expect(flags('data-[selected=true]:bg-accent text-muted-foreground')).toEqual([
      'accent/muted-foreground',
    ]);
  });

  it('catches a variant fill whose state sets no ink of its own', () => {
    // The ink falls through to the unprefixed `text-muted-foreground`, so on
    // hover the icon keeps a muted colour while the fill turns to accent.
    // Two real instances of this were in pages-client.tsx.
    expect(flags('rounded text-muted-foreground hover:bg-accent')).toEqual([
      'accent/muted-foreground',
    ]);
  });

  it("catches one fill wearing another fill's foreground", () => {
    expect(flags('bg-primary text-card-foreground')).toEqual(['primary/card-foreground']);
  });
});

describe('the ESLint rule wiring', () => {
  it('reports on className JSX attributes and cn() arguments', () => {
    const ruleTester = new RuleTester({
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
    });

    // RuleTester throws on any mismatch between expectation and behaviour.
    ruleTester.run('pair-fill-foreground', rule, {
      valid: [
        { code: '<button className="hover:bg-accent hover:text-accent-foreground" />' },
        { code: 'cn("bg-primary text-primary-foreground")' },
      ],
      invalid: [
        {
          code: '<button className="text-muted-foreground hover:bg-accent" />',
          errors: [{ messageId: 'mismatch' }],
        },
        {
          code: 'cn("bg-primary text-muted-foreground")',
          errors: [{ messageId: 'mismatch' }],
        },
      ],
    });
  });
});
