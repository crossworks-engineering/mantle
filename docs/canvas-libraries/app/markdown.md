# Markdown in a mini app (markdown-it and DOMPurify)

Version: markdown-it 15.0.3, as this brain's app runtime serves it, with
dompurify 3.4.17.
Source: the markdown-it docs (its API and options) and the DOMPurify
README (config, hooks). Written for Mantle, not copied.

## Import

```tsx
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
```

Default imports, both. The frame's import map serves them; they are not
bundled into the app. One guide, because the two go together: **markdown-it
output reaches the DOM only through `DOMPurify.sanitize`.**

## In a React component

- Make one renderer at module scope:
  `const md = new MarkdownIt({ html: false, linkify: true, typographer: true })`.
  Keep `html: false` (the default): raw HTML in the text is escaped.
- Render and clean, every time:
  `const html = DOMPurify.sanitize(md.render(text))`, in `useMemo` keyed on
  the text, then `<div dangerouslySetInnerHTML={{ __html: html }} />`.
  markdown-it alone is not a sanitizer: a plugin, an option changed later,
  or a link it lets through can still carry markup. DOMPurify removes
  scripts, event handlers and `javascript:` links. Never skip it, even for
  text the app wrote: notes from `host.db` were typed by someone.
- Links: a click on a link would load another page in place of the app.
  The hook below gives each link `target="_blank"`; the frame's sandbox has
  no popups, so a link shows but goes nowhere. Show the URL as text when
  people need it.
- Images: the frame loads no picture from another site (its CSP). A
  `data:` image works; for a stored image use `file_read` with `bytes`.
- Built in: headings, lists, emphasis, code, block quotes, tables,
  strikethrough. Not built in: task lists, footnotes, maths (use `katex`).
- Style the output with theme classes on the container
  (`[&_h2]:text-xl`, `[&_a]:text-primary`, `[&_code]:bg-muted`): the app
  stylesheet resets headings and lists, so they need their sizes back.
- `md.renderInline(text)` for one line with no paragraph around it.
- `DOMPurify.addHook` changes the shared instance: add hooks once, at
  module scope.

## App example

```tsx
import { useMemo, useState } from 'react';
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import { Card, CardContent } from '@/components/ui/card';

const md = new MarkdownIt({ html: false, linkify: true, typographer: true });
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const START = `## Shift handover

**Unit 2** is back on line. Watch the *reflux drum* level.

- PT-1042 reads 12.5 bar, steady
- PSV-14 test is \`due\` on Friday
- ~~Pump P-305B~~ is repaired

| Tag | Reading |
| --- | ------- |
| TT-1043 | 61 degC |
| FT-2201 | 38 m3/h |

<img src=x onerror="alert(1)"> stays text: html is off, and DOMPurify cleans the rest.`;

const PROSE =
  'space-y-3 text-sm [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 ' +
  '[&_h2]:text-xl [&_h2]:font-semibold [&_li]:ml-5 [&_ul]:list-disc [&_table]:w-full ' +
  '[&_td]:border [&_td]:px-2 [&_th]:border [&_th]:bg-muted [&_th]:px-2 [&_th]:text-left';

export default function App() {
  const [text, setText] = useState(START);
  const html = useMemo(() => DOMPurify.sanitize(md.render(text)), [text]);
  return (
    <div className="mx-auto grid max-w-5xl gap-4 p-6 text-foreground md:grid-cols-2">
      <textarea
        className="min-h-[420px] rounded-lg border bg-background p-3 font-mono text-sm"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <Card>
        <CardContent className="pt-6">
          <div className={PROSE} dangerouslySetInnerHTML={{ __html: html }} />
        </CardContent>
      </Card>
    </div>
  );
}
```
