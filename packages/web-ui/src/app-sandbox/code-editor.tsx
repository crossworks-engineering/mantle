'use client';

/**
 * Lightweight code editor for mini-app source. A transparent <textarea> over a
 * syntax-highlighted <pre> (the classic overlay technique) — so you get live
 * highlighting while typing without pulling in a heavy editor (CodeMirror /
 * Monaco). Both layers share identical text metrics so the caret tracks the
 * highlighted glyphs exactly. Theme-aware via the `.code-view` CSS scope.
 *
 * Deliberately simple: no gutter, no autocomplete, no multi-cursor. Editing +
 * Tab-to-indent + the parent's Format/Save is the whole feature. Pass
 * `readOnly` to render the same highlighted surface without the textarea.
 */
import { useMemo } from 'react';
import { cn } from '../lib/utils';
import { highlightToReact } from './highlight';

// Shared text metrics — MUST match between the highlight layer and the textarea
// or the caret drifts from the glyphs. pre-wrap + break-words keeps long lines
// aligned without a separate horizontal-scroll sync.
const TEXT = 'm-0 whitespace-pre-wrap break-words px-3 py-3 font-mono text-xs leading-relaxed';

export function CodeEditor({
  path,
  value,
  onChange,
  readOnly = false,
  className,
}: {
  path: string;
  value: string;
  onChange?: (next: string) => void;
  readOnly?: boolean;
  className?: string;
}) {
  const highlighted = useMemo(() => highlightToReact(path, value), [path, value]);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== 'Tab' || !onChange) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: end } = el;
    const next = value.slice(0, s) + '  ' + value.slice(end);
    onChange(next);
    // Restore the caret just after the inserted two spaces (post-render).
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = s + 2;
    });
  }

  return (
    <div className={cn('code-view relative overflow-auto bg-card', className)}>
      <pre
        aria-hidden
        className={cn('hljs pointer-events-none min-h-full text-card-foreground', TEXT)}
      >
        <code>
          {highlighted}
          {'\n'}
        </code>
      </pre>
      {!readOnly && (
        <textarea
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="soft"
          className={cn(
            'absolute inset-0 resize-none overflow-hidden border-0 bg-transparent text-transparent caret-foreground outline-none',
            TEXT,
          )}
        />
      )}
    </div>
  );
}
