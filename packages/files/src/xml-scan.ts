/**
 * A linear pass over the tags of machine-written XML, for the readers that
 * collect references and text runs in source order (./pptx.ts,
 * ./ooxml-media.ts, ./vsdx.ts) without a full parser.
 *
 * They used regular expressions like `<a:t[^>]*>([\s\S]*?)<\/a:t>`, which
 * are quadratic on hostile input: every `<a:t>` with no close scans to the
 * end of the part, so 512 KB of unclosed `<a:t>` took 9.1 s. Here each tag
 * costs one forward `indexOf('<')` and one `indexOf('>')`, and an element's
 * text one forward search for its close tag; a search that finds nothing
 * stays nothing for the rest of the part ({@link forwardFinder}). Every
 * needle is searched across the text at most once, so a part reads in time
 * linear in its size whatever it holds.
 *
 * A tag is `<` up to the next `>`, as the regular expressions read it; its
 * name runs to the first space, `/` or `>`.
 */

/**
 * `indexOf` for a scanner that only moves forward. Each search starts at or
 * after the last one, so a found position stays the answer until the scanner
 * passes it, and a miss stays a miss for the rest of the text. Every needle
 * is then searched across the text at most once, which is what keeps a scan
 * linear on hostile input.
 */
export function forwardFinder(find: (from: number) => number): (from: number) => number {
  let last = -2;
  return (from) => {
    if (last === -1 || last >= from) return last;
    last = find(from);
    return last;
  };
}

export type XmlTag = {
  /** The element name with its prefix (`a:t`), without a closing `/`. */
  readonly name: string;
  /** `</name>`. */
  readonly closing: boolean;
  /** `<name ... />`. */
  readonly selfClosing: boolean;
  /** Where the `<` is, and just past the `>`. */
  readonly start: number;
  readonly end: number;
};

function isNameEnd(c: number): boolean {
  // space, tab, CR, LF, `/`, `>`
  return c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a || c === 0x2f || c === 0x3e;
}

/** The tags of one XML text, in order, with a cursor that can skip ahead
 *  (past an element's text) and never moves back. */
export class TagScanner {
  private pos = 0;
  private readonly gt: (from: number) => number;
  private readonly closers = new Map<string, (from: number) => number>();

  constructor(readonly xml: string) {
    this.gt = forwardFinder((from) => xml.indexOf('>', from));
  }

  /** The next tag, or null at the end (or at a `<` with no `>` after it). */
  next(): XmlTag | null {
    const xml = this.xml;
    const lt = xml.indexOf('<', this.pos);
    if (lt === -1) return null;
    const gt = this.gt(lt + 1);
    if (gt === -1) {
      this.pos = xml.length;
      return null;
    }
    this.pos = gt + 1;
    let i = lt + 1;
    const closing = xml.charCodeAt(i) === 0x2f;
    if (closing) i++;
    let j = i;
    while (j < gt && !isNameEnd(xml.charCodeAt(j))) j++;
    return {
      name: xml.slice(i, j),
      closing,
      selfClosing: !closing && gt > lt + 1 && xml.charCodeAt(gt - 1) === 0x2f,
      start: lt,
      end: gt + 1,
    };
  }

  /** The tag's own text, `<` to `>`. */
  text(tag: XmlTag): string {
    return this.xml.slice(tag.start, tag.end);
  }

  /**
   * The text of the element `tag` opens, up to its `</name>`, and the cursor
   * moved past that close; null (cursor unmoved) when no close follows, as
   * the regular expressions this replaces skipped such an element.
   */
  elementText(tag: XmlTag): string | null {
    let find = this.closers.get(tag.name);
    if (!find) {
      const needle = `</${tag.name}>`;
      find = forwardFinder((from) => this.xml.indexOf(needle, from));
      this.closers.set(tag.name, find);
    }
    const close = find(tag.end);
    if (close === -1) return null;
    this.pos = close + tag.name.length + 3;
    return this.xml.slice(tag.end, close);
  }
}

/** Each tag of `xml` whose name passes `keep`, as its text, in order. */
export function tagsNamed(xml: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  const scan = new TagScanner(xml);
  for (let tag = scan.next(); tag; tag = scan.next()) {
    if (!tag.closing && keep(tag.name)) out.push(scan.text(tag));
  }
  return out;
}

/** The local part of a prefixed name (`a:blip` is `blip`). */
export function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/** `s` without trailing spaces and tabs, in one pass from the end (the
 *  regular expression `/[ \t]+$/` is quadratic on a long run of spaces
 *  followed by anything else). */
export function trimEndSpaceTab(s: string): string {
  let end = s.length;
  while (end > 0) {
    const c = s.charCodeAt(end - 1);
    if (c !== 0x20 && c !== 0x09) break;
    end--;
  }
  return end === s.length ? s : s.slice(0, end);
}
