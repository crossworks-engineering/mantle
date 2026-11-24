/**
 * The Reader `mail` on made-up mails: an `.eml` (plain, HTML only, an
 * 8-bit charset, attachments), an `.mbox` (split, mboxrd escapes, the text
 * and time caps), and an Outlook `.msg` written by ./msg.test-helper.ts
 * (plain, HTML and RTF bodies, recipients, attachments). No client mail.
 */
import { describe, expect, it } from 'vitest';
import { readCutHint, cutMakesPartial } from '../../../read-cut';
import type { FileTabsWriteInput, StepJob } from '../../contract';
import { mailTab, mailText, readMail, splitMbox } from './mail';
import { madeUpMsg } from './msg.test-helper';
import { MAIL_DESCRIPTION, step } from './step';

const crlf = (lines: string[]) => Buffer.from(lines.join('\r\n'), 'latin1');

const PLAIN = crlf([
  'From: Ada Example <ada@example.test>',
  'To: Bo Example <bo@example.test>, ops@example.test',
  'Cc: Cy Example <cy@example.test>',
  'Date: Tue, 03 Nov 2026 09:30:00 +0200',
  'Subject: Pump P-101 seal',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'The seal on P-101 leaks at 4 bar.',
  'Second line of the body.',
  '--b1',
  'Content-Type: application/pdf; name="datasheet.pdf"',
  'Content-Disposition: attachment; filename="datasheet.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-1.4 made up').toString('base64'),
  '--b1--',
  '',
]);

const HTML_ONLY = crlf([
  'From: ada@example.test',
  'Subject: Table',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><head><style>p{}</style></head><body><p>Hello <b>team</b></p><table><tr><td>A</td><td>B</td></tr></table></body></html>',
]);

const LATIN1 = Buffer.concat([
  crlf([
    'From: x@example.test',
    'Subject: =?iso-8859-1?Q?Caf=E9?=',
    'Content-Type: text/plain; charset=iso-8859-1',
    'Content-Transfer-Encoding: 8bit',
    '',
    '',
  ]),
  Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x6f, 0x75, 0x76, 0x65, 0x72, 0x74]), // "Café ouvert"
]);

const mboxOf = (bodies: string[]) =>
  Buffer.from(
    bodies
      .map(
        (b, i) =>
          `From sender${i}@example.test Tue Nov  3 09:30:00 2026\nFrom: sender${i}@example.test\nSubject: Note ${i + 1}\n\n${b}\n`,
      )
      .join('\n'),
    'latin1',
  );

describe('an .eml', () => {
  it('gives its headers, its whole body and its attachments by name', async () => {
    const read = await readMail(PLAIN, 'eml');
    expect(read).toMatchObject({ total: 1, stopped: null, whole: 1 });
    const [m] = read.messages;
    expect(m).toMatchObject({
      from: '"Ada Example" <ada@example.test>',
      cc: '"Cy Example" <cy@example.test>',
      date: '2026-11-03T07:30:00.000Z',
      subject: 'Pump P-101 seal',
      body: 'The seal on P-101 leaks at 4 bar.\nSecond line of the body.',
    });
    expect(m!.to).toContain('ops@example.test');
    expect(m!.attachments).toEqual([{ name: 'datasheet.pdf', type: 'application/pdf', bytes: 16 }]);
    const text = mailText(read, 'eml');
    expect(text).toContain('Subject: Pump P-101 seal');
    expect(text).toContain('leaks at 4 bar');
    expect(text).toContain(
      'Attachments (named only, not read):\n- datasheet.pdf (application/pdf, 16 bytes)',
    );
    // The attachment's bytes are never read into the text.
    expect(text).not.toContain('made up');
    expect(text).not.toContain('## Message');
  });

  it('reads an HTML body through the markup reader when there is no text part', async () => {
    const [m] = (await readMail(HTML_ONLY, 'eml')).messages;
    expect(m!.body).toContain('Hello team');
    expect(m!.body).toContain('A\tB');
    expect(m!.body).not.toContain('<');
    expect(m!.body).not.toContain('p{}');
  });

  it('decodes an 8-bit charset and an encoded subject', async () => {
    const [m] = (await readMail(LATIN1, 'eml')).messages;
    expect(m).toMatchObject({ subject: 'Café', body: 'Café ouvert' });
  });

  it('reads an .msg that is no OLE2 file as an .eml (a renamed message)', async () => {
    const [m] = (await readMail(PLAIN, 'msg')).messages;
    expect(m!.subject).toBe('Pump P-101 seal');
  });
});

describe('an .mbox', () => {
  it('splits on the From line, one message each, and unescapes >From', () => {
    const parts = splitMbox(mboxOf(['one', '>From the start\n>>From two', 'three']));
    expect(parts).toHaveLength(3);
    expect(parts[1]!.toString('latin1')).toContain('\nFrom the start\n>From two');
    expect(parts[0]!.toString('latin1').startsWith('From: sender0')).toBe(true);
  });

  it('skips a byte order mark and blank lines before the first From line', () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('\r\n\n'),
      mboxOf(['x', 'y']),
    ]);
    expect(splitMbox(bytes)).toHaveLength(2);
  });

  it('is one message when it does not start with From, and none when empty', () => {
    expect(splitMbox(PLAIN)).toEqual([PLAIN]);
    expect(splitMbox(Buffer.alloc(0))).toEqual([]);
  });

  it('gives a heading a message and a row a message', async () => {
    const read = await readMail(mboxOf(['alpha', 'beta', 'gamma']), 'mbox');
    expect(read).toMatchObject({ total: 3, stopped: null, whole: 3 });
    const text = mailText(read, 'mbox');
    expect(text).toMatch(/^## Message 1\n\nFrom: sender0@example.test/);
    expect(text).toContain('## Message 3');
    expect(text).toContain('gamma');
    const tab = mailTab(read);
    expect(tab.columns.map((c) => c.name)).toEqual([
      'Message',
      'From',
      'To',
      'Cc',
      'Bcc',
      'Date',
      'Subject',
      'Attachments',
    ]);
    expect(tab.rows.map((r) => r[0])).toEqual([1, 2, 3]);
    expect(tab.rows[1]![6]).toBe('Note 2');
  });

  it('stops at the text cap and counts the messages it left out', async () => {
    const read = await readMail(
      mboxOf(['a'.repeat(1000), 'b'.repeat(1000), 'c'.repeat(1000)]),
      'mbox',
      { maxBytes: 2600 },
    );
    expect(read).toMatchObject({ total: 3, stopped: 'text', whole: 2 });
    expect(read.messages).toHaveLength(2);
  });

  it('keeps the head of a first message past the text cap, read in part', async () => {
    const read = await readMail(mboxOf(['z'.repeat(5000)]), 'mbox', { maxBytes: 1000 });
    expect(read).toMatchObject({ total: 1, stopped: 'text', whole: 0 });
    expect(read.messages[0]!.body.length).toBeGreaterThan(500);
    expect(read.messages[0]!.body.length).toBeLessThan(1000);
  });

  it('stops at the time cap after a message, never before the first', async () => {
    let t = 0;
    const read = await readMail(mboxOf(['a', 'b', 'c']), 'mbox', {
      maxMs: 5,
      now: () => (t += 10),
    });
    expect(read).toMatchObject({ total: 3, stopped: 'time', whole: 1 });
  });
});

describe('a message that cannot be read', () => {
  const huge = `From: x@example.test\nX-Pad: ${'a'.repeat(1_200_000)}\nSubject: Big\n\nbody`;

  it('in a mailbox is counted as not read, and the others are kept', async () => {
    const mbox = Buffer.from(
      `From a@example.test Tue Nov  3 09:30:00 2026\nSubject: A\n\nfirst\n\nFrom b@example.test Tue Nov  3 09:30:00 2026\n${huge}\n\nFrom c@example.test Tue Nov  3 09:30:00 2026\nSubject: C\n\nthird\n`,
      'latin1',
    );
    const read = await readMail(mbox, 'mbox');
    expect(read).toMatchObject({ total: 3, whole: 2, stopped: null });
    expect(mailText(read, 'mbox')).toContain('## Message 2\n\n[This message could not be read.]');
    expect(mailText(read, 'mbox')).toContain('third');
  });

  it('alone throws, so the file gets its word', async () => {
    await expect(readMail(Buffer.from(huge, 'latin1'), 'eml')).rejects.toThrow();
  });
});

describe('an Outlook .msg', () => {
  const submitted = Date.UTC(2026, 10, 3, 7, 30);

  it('gives its sender, recipients by type, date, body and attachments by name', async () => {
    const bytes = madeUpMsg({
      subject: 'Valve V-7 test',
      senderName: 'Ada Example',
      senderSmtp: 'ada@example.test',
      body: 'Test passed at 10 bar.',
      submitted,
      recipients: [
        { name: 'Bo Example', smtp: 'bo@example.test', type: 'to' },
        { name: 'Cy Example', smtp: 'cy@example.test', type: 'cc' },
        { name: 'Di Example', smtp: 'di@example.test', type: 'bcc' },
      ],
      attachments: [
        {
          name: 'report.xlsx',
          mime: 'application/vnd.ms-excel',
          data: Buffer.from('made up bytes'),
        },
      ],
    });
    const read = await readMail(bytes, 'msg');
    expect(read).toMatchObject({ total: 1, stopped: null, whole: 1 });
    expect(read.messages[0]).toEqual({
      from: 'Ada Example <ada@example.test>',
      to: 'Bo Example <bo@example.test>',
      cc: 'Cy Example <cy@example.test>',
      bcc: 'Di Example <di@example.test>',
      date: '2026-11-03T07:30:00.000Z',
      subject: 'Valve V-7 test',
      body: 'Test passed at 10 bar.',
      attachments: [{ name: 'report.xlsx', type: 'application/vnd.ms-excel', bytes: 13 }],
      whole: true,
    });
    expect(mailText(read, 'msg')).not.toContain('made up bytes');
  });

  it('reads an HTML body when there is no plain one', async () => {
    const [m] = (
      await readMail(
        madeUpMsg({ subject: 'H', bodyHtml: '<p>Line <i>one</i></p><p>Line two</p>' }),
        'msg',
      )
    ).messages;
    expect(m!.body).toMatch(/^Line one\n+Line two$/);
  });

  it('reads an RTF body when there is neither', async () => {
    const rtf = '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0 Flow is 12 m3/h.\\par}';
    const [m] = (await readMail(madeUpMsg({ subject: 'R', rtf }), 'msg')).messages;
    expect(m!.body).toContain('Flow is 12 m3/h.');
  });

  it('does not unpack an RTF body whose header claims more than its bytes, and counts it', async () => {
    const bytes = madeUpMsg({ subject: 'R', rtfHeaderSize: 20_000_000, rtf: '{\\rtf1 x}' });
    const read = await readMail(bytes, 'msg');
    expect(read).toMatchObject({ total: 1, whole: 0 });
    expect(read.messages[0]!.body).toBe('');
  });

  it('is read as an Outlook message by its bytes, whatever its name', async () => {
    const [m] = (await readMail(madeUpMsg({ subject: 'Named eml', body: 'b' }), 'eml')).messages;
    expect(m!.subject).toBe('Named eml');
  });

  it('throws on an OLE2 file that is no message', async () => {
    const junk = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(600, 7),
    ]);
    await expect(readMail(junk, 'msg')).rejects.toThrow();
  });
});

describe('the step', () => {
  const jobOf = (bytes: Buffer) => ({ bytes: async () => bytes }) as unknown as StepJob;
  const run = async (bytes: Buffer, ext: string) => {
    const r = await step(
      {
        api: 1,
        step: 1,
        options: {},
        file: { name: `x.${ext}`, ext, size: bytes.length, sha256: '0'.repeat(64) },
      },
      jobOf(bytes),
    );
    return {
      r,
      input:
        r.status === 'ok'
          ? (r.calls?.[0] as { input: FileTabsWriteInput } | undefined)?.input
          : undefined,
    };
  };

  it('writes the tab Mail, the text and the description, and names the attachments as a detail', async () => {
    const { r, input } = await run(PLAIN, 'eml');
    expect(r.status).toBe('ok');
    expect(input!.tabs.map((t) => t.name)).toEqual(['Mail']);
    expect(input!.description).toBe(MAIL_DESCRIPTION);
    expect(input!.text).toContain('leaks at 4 bar');
    expect(input!.readCuts).toEqual({
      mail_attachments: { what: 'attachments', read: 0, total: 1 },
    });
    // A detail: the file stays indexed, as an archive's entries do.
    expect(cutMakesPartial('mail_attachments')).toBe(false);
    expect(readCutHint('mail_attachments', input!.readCuts!.mail_attachments!)).toBe(
      'Its 1 attachment is not read, only named in search. To read one, upload it as its own file.',
    );
  });

  it('says no cut for a mail with no attachment', async () => {
    const { input } = await run(HTML_ONLY, 'eml');
    expect(input!.readCuts).toBeUndefined();
  });

  it('writes nothing for an empty mailbox', async () => {
    const { r } = await run(Buffer.alloc(0), 'mbox');
    expect(r).toEqual({ status: 'ok' });
  });

  it('says a mailbox read in part, which makes the file partial', () => {
    expect(cutMakesPartial('mail_messages')).toBe(true);
    expect(readCutHint('mail_messages', { what: 'messages', read: 2, total: 5 })).toBe(
      'Only 2 of 5 messages were read in full. The others are not in search, or only in part.',
    );
    expect(readCutHint('mail_messages', { what: 'messages', read: 0, total: 1 })).toBe(
      'Its message was read in part. The rest of it is not in search.',
    );
  });
});
