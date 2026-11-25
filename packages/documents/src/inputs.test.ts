/**
 * Inputs are refs, never paths: file ids read in the caller's scope, a node
 * id printed with a render cookie minted for the caller, inline html or
 * markdown. What must hold: the caps (per input, in total, inline, count),
 * the route's input kind (an Office file on a PDF route is refused with the
 * fix), the extras only where the route takes them, and a node print only
 * for a login (the cookie names it) and only for a page or a drawing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RENDER_COOKIE_NAME } from './render-token';
import {
  DOCUMENTS_MAX_FILES,
  DOCUMENTS_MAX_INLINE_BYTES,
  DOCUMENTS_MAX_INPUT_BYTES,
  DOCUMENTS_MAX_TOTAL_BYTES,
  checkMarkdownWrapper,
  notPlain,
  resolveInputs,
  type InputDeps,
} from './inputs';
import { findRoute } from './routes';

const F = {
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': { filename: 'plan.docx', bytes: Buffer.from('docx') },
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb': { filename: 'a.pdf', bytes: Buffer.from('pdf-a') },
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc': { filename: 'b.pdf', bytes: Buffer.from('pdf-b') },
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd': { filename: 'logo.png', bytes: Buffer.from('png') },
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee': { filename: 'notes.md', bytes: Buffer.from('# hi') },
  'ffffffff-ffff-4fff-8fff-ffffffffffff': {
    filename: 'index.html',
    bytes: Buffer.from('<p>x</p>'),
  },
};
const PAGE = '11111111-1111-4111-8111-111111111111';
const DRAW = '22222222-2222-4222-8222-222222222222';
const TABLE = '33333333-3333-4333-8333-333333333333';
const reads: string[] = [];
const deps: InputDeps = {
  readFile: async (ownerId, id) => {
    reads.push(`${ownerId}:${id}`);
    return (F as Record<string, { filename: string; bytes: Buffer }>)[id] ?? null;
  },
  nodeKind: async (_o, id) =>
    id === PAGE ? 'page' : id === DRAW ? 'draw' : id === TABLE ? 'other' : null,
};
const caller = { ownerId: 'o1', actorLoginId: '44444444-4444-4444-8444-444444444444' };
const r = (k: string) => findRoute(k)!;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  reads.length = 0;
  for (const k of ['SESSION_SECRET', 'MANTLE_PRINT_ORIGIN']) saved[k] = process.env[k];
  process.env.SESSION_SECRET = 'a-session-secret-of-at-least-32-characters';
  process.env.MANTLE_PRINT_ORIGIN = 'http://web:3000';
});
afterEach(() => {
  for (const k of ['SESSION_SECRET', 'MANTLE_PRINT_ORIGIN']) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('files', () => {
  it('reads each file in the caller scope and names the parts', async () => {
    const out = await resolveInputs(
      r('pdfengines/merge'),
      { file_ids: Object.keys(F).slice(1, 3) },
      caller,
      deps,
    );
    expect(out.parts.map((p) => [p.field, p.filename])).toEqual([
      ['files', 'a.pdf'],
      ['files', 'b.pdf'],
    ]);
    expect(reads).toEqual([
      'o1:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'o1:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ]);
    expect(out.stem).toBe('a');
    expect(out.exportOf).toBeNull();
    expect(out.node).toBeNull();
  });

  it('refuses a missing file, a non-uuid, and the wrong kind for the route', async () => {
    await expect(
      resolveInputs(
        r('pdfengines/merge'),
        { file_ids: ['99999999-9999-4999-8999-999999999999'] },
        caller,
        deps,
      ),
    ).rejects.toThrow(/not found, or you may not read it/);
    await expect(
      resolveInputs(r('pdfengines/merge'), { file_ids: ['nope'] }, caller, deps),
    ).rejects.toThrow(/file id \(uuid\)/);
    await expect(
      resolveInputs(
        r('pdfengines/merge'),
        { file_ids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] },
        caller,
        deps,
      ),
    ).rejects.toThrow(/not a PDF.*libreoffice\/convert/);
    await expect(
      resolveInputs(
        r('libreoffice/convert'),
        {
          file_ids: [
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          ],
        },
        caller,
        deps,
      ),
    ).resolves.toMatchObject({ stem: 'a' });
    await expect(resolveInputs(r('pdfengines/merge'), {}, caller, deps)).rejects.toThrow(
      /file_ids is required/,
    );
    await expect(resolveInputs(r('pdfengines/merge'), { nope: 1 }, caller, deps)).rejects.toThrow(
      /inputs.nope is not an input/,
    );
    await expect(resolveInputs(r('pdfengines/merge'), [], caller, deps)).rejects.toThrow(
      /must be an object/,
    );
  });

  it('an Office file of an unknown type names the common ones', async () => {
    const d: InputDeps = {
      ...deps,
      readFile: async () => ({ filename: 'x.exe', bytes: Buffer.from('x') }),
    };
    await expect(
      resolveInputs(
        r('libreoffice/convert'),
        { file_ids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] },
        caller,
        d,
      ),
    ).rejects.toThrow(/\.exe\) is not a type LibreOffice reads; common ones are \.docx/);
  });

  it('caps: count, one input, the total, the inline texts', async () => {
    const many = Array.from(
      { length: DOCUMENTS_MAX_FILES + 1 },
      (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`,
    );
    await expect(
      resolveInputs(r('pdfengines/merge'), { file_ids: many }, caller, deps),
    ).rejects.toThrow(/at most 50 files/);
    const big: InputDeps = {
      ...deps,
      readFile: async () => ({
        filename: 'big.pdf',
        bytes: Buffer.alloc(DOCUMENTS_MAX_INPUT_BYTES + 1),
      }),
    };
    await expect(
      resolveInputs(
        r('pdfengines/merge'),
        { file_ids: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] },
        caller,
        big,
      ),
    ).rejects.toThrow(/one input may be at most 64 MB/);
    let n = 0;
    const sum: InputDeps = {
      ...deps,
      readFile: async () => ({
        filename: `p${(n += 1)}.pdf`,
        bytes: Buffer.alloc(DOCUMENTS_MAX_TOTAL_BYTES / 2),
      }),
    };
    await expect(
      resolveInputs(
        r('pdfengines/merge'),
        {
          file_ids: [
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          ],
        },
        caller,
        sum,
      ),
    ).rejects.toThrow(/together pass 64 MB/);
    await expect(
      resolveInputs(
        r('chromium/convert/html'),
        { html: 'x'.repeat(DOCUMENTS_MAX_INLINE_BYTES + 1) },
        caller,
        deps,
      ),
    ).rejects.toThrow(/html is larger than 4 MB/);
  });

  it('two parts of one name are refused (the engine keeps one flat directory)', async () => {
    const same: InputDeps = {
      ...deps,
      readFile: async () => ({ filename: 'same.pdf', bytes: Buffer.from('x') }),
    };
    await expect(
      resolveInputs(
        r('pdfengines/merge'),
        {
          file_ids: [
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          ],
        },
        caller,
        same,
      ),
    ).rejects.toThrow(/both named "same\.pdf"/);
  });
});

describe('html and markdown', () => {
  it('inline html is index.html; assets ride beside it', async () => {
    const out = await resolveInputs(
      r('chromium/convert/html'),
      {
        html: '<h1>Hi</h1>',
        asset_file_ids: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
        header_html: '<p>h</p>',
        footer_html: '<p>f</p>',
      },
      caller,
      deps,
    );
    expect(out.parts.map((p) => p.filename)).toEqual([
      'index.html',
      'logo.png',
      'header.html',
      'footer.html',
    ]);
    expect(out.parts[0]!.bytes.toString()).toBe('<h1>Hi</h1>');
  });

  it('or one .html file; never both, never markdown', async () => {
    expect(
      (
        await resolveInputs(
          r('chromium/convert/html'),
          { file_ids: ['ffffffff-ffff-4fff-8fff-ffffffffffff'] },
          caller,
          deps,
        )
      ).parts[0]!.filename,
    ).toBe('index.html');
    await expect(
      resolveInputs(
        r('chromium/convert/html'),
        { html: 'x', file_ids: ['ffffffff-ffff-4fff-8fff-ffffffffffff'] },
        caller,
        deps,
      ),
    ).rejects.toThrow(/not both/);
    await expect(
      resolveInputs(
        r('chromium/convert/html'),
        { file_ids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] },
        caller,
        deps,
      ),
    ).rejects.toThrow(/not an HTML file/);
    await expect(
      resolveInputs(r('chromium/convert/html'), { markdown: '# x' }, caller, deps),
    ).rejects.toThrow(/chromium\/convert\/markdown/);
    await expect(resolveInputs(r('chromium/convert/html'), {}, caller, deps)).rejects.toThrow(
      /html \(inline\) or one \.html file in file_ids is required/,
    );
  });

  it('markdown gets a wrapper that places it, or the caller wrapper with toHTML', async () => {
    const out = await resolveInputs(
      r('chromium/convert/markdown'),
      { markdown: '# Hi', file_ids: ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'] },
      caller,
      deps,
    );
    expect(out.parts.map((p) => p.filename)).toEqual(['file.md', 'notes.md', 'index.html']);
    expect(out.parts[2]!.bytes.toString()).toContain('{{ toHTML "file.md" }}');
    expect(out.parts[2]!.bytes.toString()).toContain('{{ toHTML "notes.md" }}');
    expect(out.stem).toBe('notes');
    await expect(
      resolveInputs(
        r('chromium/convert/markdown'),
        { markdown: '# Hi', html: '<body>no place</body>' },
        caller,
        deps,
      ),
    ).rejects.toThrow(/toHTML/);
    await expect(
      resolveInputs(
        r('chromium/convert/markdown'),
        { file_ids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] },
        caller,
        deps,
      ),
    ).rejects.toThrow(/not a markdown file/);
  });

  it('an asset may not replace the document, its header or its footer', async () => {
    const chrome: InputDeps = {
      ...deps,
      readFile: async () => ({ filename: 'footer.html', bytes: Buffer.from('<p>x</p>') }),
    };
    await expect(
      resolveInputs(
        r('chromium/convert/html'),
        { html: 'x', asset_file_ids: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'] },
        caller,
        chrome,
      ),
    ).rejects.toThrow(/would replace the document, its header or its footer/);
    await expect(
      resolveInputs(
        r('chromium/convert/html'),
        { html: 'x', asset_file_ids: ['ffffffff-ffff-4fff-8fff-ffffffffffff'] },
        caller,
        deps,
      ),
    ).rejects.toThrow(/would replace the document/);
    await expect(
      resolveInputs(
        r('pdfengines/merge'),
        { file_ids: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'], asset_file_ids: [] },
        caller,
        deps,
      ),
    ).rejects.toThrow(/asset_file_ids belongs to/);
  });
});

describe('the markdown wrapper is no template (GHSA-2m5g-g83x-jqp7)', () => {
  const NAMES = ['file.md', 'notes.md', 'Report {final}.md'];
  const ALLOWED = [
    '<body>{{ toHTML "file.md" }}</body>',
    '<body>{{toHTML "file.md"}}</body>',
    '<body>{{- toHTML "file.md" -}}</body>',
    '<body>{{-\ttoHTML\n"file.md"\r\n-}}</body>',
    '<body>{{ toHTML `file.md` }}</body>',
    '<h1>A}}</h1>{{ toHTML "file.md" }}<hr>{{ toHTML "notes.md" }}',
    '{{ toHTML "Report {final}.md" }}',
  ];
  const REFUSED: Record<string, string> = {
    'a range over an integer': '{{range 100000}}0123456789abcdef{{end}}{{ toHTML "file.md" }}',
    'a range that only loops': '{{ toHTML "file.md" }}{{range 1000000000000000}}{{end}}',
    'define and template': '{{define "a"}}x{{end}}{{template "a"}}{{ toHTML "file.md" }}',
    'a comment': '{{/* a */}}{{ toHTML "file.md" }}',
    'a trimmed comment': '{{- /* a */ -}}{{ toHTML "file.md" }}',
    'a pipe into toHTML': '{{ "file.md" | toHTML }}',
    'toHTML in parens': '{{ (toHTML "file.md") }}',
    'a variable': '{{ $x := toHTML "file.md" }}{{ $x }}',
    'an extra argument': '{{ toHTML "file.md" "notes.md" }}',
    'a third brace': '{{{ toHTML "file.md" }}',
    'an escape in the name': '{{ toHTML "file\\x2emd" }}',
    'a trim marker with no space': '{{-toHTML "file.md"}}',
    'a literal {{ in a script': '<script>if (a) {{ b() }}</script>{{ toHTML "file.md" }}',
    'a {{ in an HTML comment': '<!-- {{range 9}}{{end}} -->{{ toHTML "file.md" }}',
  };

  it('takes {{ toHTML "name" }} with the spaces, trim markers and quotes Go takes', () => {
    for (const w of ALLOWED) expect(() => checkMarkdownWrapper(w, NAMES)).not.toThrow();
  });

  for (const [name, w] of Object.entries(REFUSED)) {
    it(`refuses ${name}, and says what is allowed`, () => {
      expect(() => checkMarkdownWrapper(w, NAMES)).toThrow(
        /may hold only \{\{ toHTML "file\.md" \}\}, once for each \.md file sent/,
      );
    });
  }

  it('refuses a name that was not sent, and a file placed twice', () => {
    expect(() => checkMarkdownWrapper('{{ toHTML "other.md" }}', NAMES)).toThrow(
      /names no \.md file sent, or names one twice; the files sent are file\.md, notes\.md/,
    );
    expect(() =>
      checkMarkdownWrapper('{{ toHTML "file.md" }}{{ toHTML "file.md" }}', NAMES),
    ).toThrow(/names one twice/);
    expect(() => checkMarkdownWrapper('<body>no place</body>', NAMES)).toThrow(
      /must place the markdown/,
    );
    // Braces inside a quoted name are text to Go's lexer: no action opens there.
    expect(() => checkMarkdownWrapper('{{ toHTML "file.md{{range 9}}" }}', NAMES)).toThrow(
      /names no \.md file sent/,
    );
    expect(() => checkMarkdownWrapper('{{range 9}}{{end}}', NAMES)).toThrow(
      /belongs in the \.md file, which is not a template/,
    );
  });

  it("guards the caller's wrapper and Mantle's own, whose file names go in it", async () => {
    await expect(
      resolveInputs(
        r('chromium/convert/markdown'),
        { markdown: '# Hi', html: '{{range 9}}{{end}}{{ toHTML "file.md" }}' },
        caller,
        deps,
      ),
    ).rejects.toThrow(/may hold only/);
    const named = (filename: string): InputDeps => ({
      ...deps,
      readFile: async () => ({ filename, bytes: Buffer.from('# x') }),
    });
    const id = ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'];
    for (const filename of ['a" }}{{range 9}}{{end}}{{ toHTML "b.md', 'a\\b.md']) {
      await expect(
        resolveInputs(r('chromium/convert/markdown'), { file_ids: id }, caller, named(filename)),
      ).rejects.toThrow(
        /^rename the file .*: a documents job takes a file name without a (double quote|backslash)$/,
      );
    }
    // Braces and markup in a name are fine: the title is escaped, and in the
    // toHTML string they are text.
    const out = await resolveInputs(
      r('chromium/convert/markdown'),
      { file_ids: id },
      caller,
      named('{{range 1000000000000000}}{{end}} <b>&.md'),
    );
    const wrapper = out.parts.find((p) => p.filename === 'index.html')!.bytes.toString();
    expect(wrapper).toContain(
      '<title>&#123;&#123;range 1000000000000000&#125;&#125;&#123;&#123;end&#125;&#125; &#60;b&#62;&#38;</title>',
    );
    expect(wrapper).toContain('{{ toHTML "{{range 1000000000000000}}{{end}} <b>&.md" }}');
  });
});

describe('plain names only, one name per file (the flat directory)', () => {
  const named = (files: Record<string, string>): InputDeps => ({
    ...deps,
    readFile: async (_o, id) => {
      const filename = files[id];
      return filename !== undefined ? { filename, bytes: Buffer.from('x') } : null;
    },
  });
  const ID = (n: number) =>
    `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
  const md = r('chromium/convert/markdown');
  const embed = (filename: string) =>
    resolveInputs(
      md,
      { markdown: '# hi', embed_file_ids: [ID(5)] },
      caller,
      named({ [ID(5)]: filename }),
    );

  it('an extra file named index.html cannot sit beside the markdown wrapper', async () => {
    const deps2 = named({ [ID(5)]: 'index.html' });
    for (const extra of [
      { embed_file_ids: [ID(5)] },
      { watermark_file_id: ID(5) },
      { stamp_file_id: ID(5) },
      { facturx_file_id: ID(5) },
    ]) {
      await expect(
        resolveInputs(md, { markdown: '# hi', ...extra }, caller, deps2),
      ).rejects.toThrow(
        /two inputs are both named "index\.html"; the engine keeps every file of a call in one flat directory/,
      );
    }
  });

  it("refuses the auditor's filename* name as an embed and as a watermark", async () => {
    const name = `a"; filename*=UTF-8''index.html; x="`;
    const deps2 = named({ [ID(5)]: name });
    for (const extra of [{ embed_file_ids: [ID(5)] }, { watermark_file_id: ID(5) }]) {
      await expect(
        resolveInputs(md, { markdown: '# hi', ...extra }, caller, deps2),
      ).rejects.toThrow(
        /^rename the file .*: a documents job takes a file name without a double quote$/,
      );
    }
  });

  const REFUSED: Array<[string, string, RegExp]> = [
    ['a double quote', 'say "hi".pdf', /without a double quote$/],
    ['a backslash', 'c:\\docs\\a.pdf', /without a backslash$/],
    ['a slash', 'folder/a.pdf', /without a slash$/],
    ['a trailing slash', 'index.html/', /without a slash$/],
    ['a carriage return', 'a\rb.pdf', /without a control character \(U\+000D\)$/],
    ['a line feed', 'a\nb.pdf', /without a control character \(U\+000A\)$/],
    ['CR LF with a header', 'a.pdf\r\nX-Injected: 1', /without a control character \(U\+000D\)$/],
    ['a tab', 'a\tb.pdf', /without a control character \(U\+0009\)$/],
    ['a NUL', 'a\u0000b.pdf', /without a control character \(U\+0000\)$/],
    ['DEL', 'a\u007fb.pdf', /without a control character \(U\+007F\)$/],
    ['half of a UTF-16 pair', 'a\ud800.pdf', /without a broken character/],
    ['a decomposed accent', 'cafe\u0301.pdf', /without letters in decomposed form/],
    ['an empty name', '', /without an empty name$/],
  ];
  for (const [what, filename, why] of REFUSED) {
    it(`refuses ${what}, for the person: rename the file`, async () => {
      await expect(embed(filename)).rejects.toThrow(/^rename the file /);
      await expect(embed(filename)).rejects.toThrow(why);
    });
  }

  it('takes ordinary names: spaces, dots, dashes, parentheses, NFC letters, braces, ; and %', async () => {
    for (const filename of [
      'Report (final) v2.pdf',
      'a.b-c_d.e.pdf',
      ' lead and trail .pdf',
      'caf\u00e9 r\u00e9sum\u00e9.pdf',
      '\u65e5\u672c\u8a9e.pdf',
      'Report {final}.md',
      'semi;colon.pdf',
      '100%.pdf',
      '..',
    ]) {
      await expect(embed(filename)).resolves.toBeTruthy();
    }
  });

  it('a name in another case of its extension is the same file to the engine', async () => {
    await expect(
      resolveInputs(
        r('pdfengines/merge'),
        { file_ids: [ID(5), ID(6)] },
        caller,
        named({ [ID(5)]: 'a.pdf', [ID(6)]: 'a.PDF' }),
      ),
    ).rejects.toThrow(/two inputs are both named "a\.pdf" and "a\.PDF"/);
    await expect(embed('index.HTML')).rejects.toThrow(/both named "index\.html" and "index\.HTML"/);
    await expect(embed('INDEX.html')).resolves.toBeTruthy();
  });

  it('two different names still pass', async () => {
    const out = await resolveInputs(
      r('pdfengines/merge'),
      { file_ids: [ID(5), ID(6)], embed_file_ids: [ID(7)] },
      caller,
      named({ [ID(5)]: 'a.pdf', [ID(6)]: 'b.pdf', [ID(7)]: 'c.pdf' }),
    );
    expect(out.parts.map((p) => p.filename)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
  });

  it('notPlain names what it found, or null', () => {
    expect(notPlain('plain name.pdf')).toBeNull();
    expect(notPlain('a/b')).toBe('a slash');
    expect(notPlain('\u001f')).toBe('a control character (U+001F)');
  });
});

describe('a node print', () => {
  it('a page: the print URL on the print origin and a render cookie for the caller login', async () => {
    const out = await resolveInputs(r('chromium/convert/url'), { node_id: PAGE }, caller, deps);
    expect(out.parts).toEqual([]);
    expect(out.node?.url).toBe(`http://web:3000/print/pages/${PAGE}`);
    expect(out.node?.kind).toBe('page');
    expect(out.exportOf).toBe(PAGE);
    const [cookie] = JSON.parse(out.node!.cookieJson) as {
      name: string;
      domain: string;
      value: string;
      httpOnly: boolean;
      secure: boolean;
      sameSite: string;
    }[];
    expect(cookie).toMatchObject({
      name: RENDER_COOKIE_NAME,
      domain: 'web',
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
    });
    const payload = JSON.parse(
      Buffer.from(cookie!.value.split('.')[0]!, 'base64url').toString(),
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({ uid: 'o1', act: caller.actorLoginId, n: PAGE, k: 'r' });
  });

  it('a drawing prints through /print/draws', async () => {
    const out = await resolveInputs(r('chromium/screenshot/url'), { node_id: DRAW }, caller, deps);
    expect(out.node).toMatchObject({ kind: 'draw', url: `http://web:3000/print/draws/${DRAW}` });
  });

  it('refuses: no login, a login the surface knows is no admin, not a page or drawing, unknown, other inputs', async () => {
    await expect(
      resolveInputs(
        r('chromium/convert/url'),
        { node_id: PAGE },
        { ...caller, admin: false },
        deps,
      ),
    ).rejects.toThrow(/signed-in Admin user/);
    await expect(
      resolveInputs(r('chromium/convert/url'), { node_id: PAGE }, { ...caller, admin: true }, deps),
    ).resolves.toBeTruthy();
    await expect(
      resolveInputs(
        r('chromium/convert/url'),
        { node_id: PAGE },
        { ownerId: 'o1', actorLoginId: null },
        deps,
      ),
    ).rejects.toThrow(/signed-in Admin user/);
    await expect(
      resolveInputs(r('chromium/convert/url'), { node_id: TABLE }, caller, deps),
    ).rejects.toThrow(/not a page or a drawing/);
    await expect(
      resolveInputs(
        r('chromium/convert/url'),
        { node_id: '99999999-9999-4999-8999-999999999999' },
        caller,
        deps,
      ),
    ).rejects.toThrow(/not found/);
    await expect(
      resolveInputs(r('chromium/convert/url'), { node_id: PAGE, html: 'x' }, caller, deps),
    ).rejects.toThrow(/node_id alone/);
    await expect(resolveInputs(r('chromium/convert/url'), {}, caller, deps)).rejects.toThrow(
      /needs node_id/,
    );
  });
});

describe('the extras', () => {
  it('a watermark, a stamp, Factur-X XML and attachments go to their own fields, on the routes that take them', async () => {
    const out = await resolveInputs(
      r('pdfengines/watermark'),
      {
        file_ids: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
        watermark_file_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      },
      caller,
      deps,
    );
    expect(out.parts.map((p) => [p.field, p.filename])).toEqual([
      ['files', 'a.pdf'],
      ['watermark', 'logo.png'],
    ]);
    const embed = await resolveInputs(
      r('pdfengines/embed'),
      {
        file_ids: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
        embed_file_ids: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
      },
      caller,
      deps,
    );
    expect(embed.parts[1]).toMatchObject({ field: 'embeds', filename: 'logo.png' });
    await expect(
      resolveInputs(
        r('pdfengines/rotate'),
        {
          file_ids: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
          stamp_file_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        },
        caller,
        deps,
      ),
    ).rejects.toThrow(/stamp_file_id is not an input of pdfengines\/rotate/);
    await expect(
      resolveInputs(
        r('pdfengines/merge'),
        { file_ids: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'], header_html: '<p/>' },
        caller,
        deps,
      ),
    ).rejects.toThrow(/header_html is not an input/);
  });
});
