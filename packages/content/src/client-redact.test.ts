/**
 * The client's view of a page or a note (client logins C2, plan N6): a
 * reference to an item the client may not read never carries its title or
 * its id to the client. Pure: `readable` stands in for the database answer.
 */
import { describe, expect, it } from 'vitest';
import { CLIENT_PRIVATE_LABEL } from '@mantle/client-types/dto/client';
import {
  cellRefIds,
  clientLinkHidden,
  clientOwnUrl,
  docRefIds,
  linkRefIds,
  noteRefIds,
  redactClientCell,
  redactClientDoc,
  redactClientNote,
} from './client-redact';

const OK = '11111111-1111-4111-8111-111111111111';
const TEAM = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const OK2 = '44444444-4444-4444-8444-444444444444';
const readable = new Set([OK, OK2]);

const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const text = (t: string, ...marks: unknown[]) => ({
  type: 'text',
  text: t,
  ...(marks.length ? { marks } : {}),
});
const link = (href: string) => ({ type: 'link', attrs: { href } });
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const json = (v: unknown) => JSON.stringify(v);

describe('redactClientDoc', () => {
  it('labels a mention chip of a hidden item "Private item" and drops its id', () => {
    const out = redactClientDoc(
      doc(para({ type: 'mention', attrs: { id: TEAM, label: 'Team roadmap', ref: 'node' } })),
      readable,
    );
    expect(out).toEqual(
      doc(
        para({
          type: 'mention',
          attrs: { id: null, label: CLIENT_PRIVATE_LABEL, ref: null, kind: null },
        }),
      ),
    );
  });

  it('labels an entity mention too: entities are never client items', () => {
    const out = json(
      redactClientDoc(
        doc(para({ type: 'mention', attrs: { id: 'ent-1', label: 'Supplier X', ref: 'entity' } })),
        readable,
      ),
    );
    expect(out).not.toContain('Supplier X');
    expect(out).not.toContain('ent-1');
    expect(out).toContain(CLIENT_PRIVATE_LABEL);
  });

  it('turns a link to a hidden item into plain "Private item", once per link', () => {
    const out = redactClientDoc(
      doc(
        para(
          text('See '),
          text('Team ', link(`/n/${TEAM}`), { type: 'bold' }),
          text('roadmap', link(`/n/${TEAM}`)),
          text(' and '),
          text('this', link(`page:${ADMIN}`)),
        ),
      ),
      readable,
    );
    expect(out).toEqual(
      doc(
        para(
          text('See '),
          text(CLIENT_PRIVATE_LABEL, { type: 'bold' }),
          text(' and '),
          text(CLIENT_PRIVATE_LABEL),
        ),
      ),
    );
  });

  it('leaves out an embed of a hidden item, and fills a container it emptied', () => {
    const out = redactClientDoc(
      doc(
        { type: 'image', attrs: { nodeId: TEAM, alt: 'Team chart' } },
        { type: 'childPage', attrs: { pageId: ADMIN, title: 'Admin notes' } },
        { type: 'fileEmbed', attrs: { nodeId: OK, filename: 'shared.pdf' } },
        { type: 'image', attrs: { src: `/api/files/files/${TEAM}?raw=1` } },
        { type: 'image', attrs: { src: 'https://example.invalid/logo.png' } },
        { type: 'blockquote', content: [{ type: 'image', attrs: { drawId: TEAM } }] },
      ),
      readable,
    );
    expect(out).toEqual(
      doc(
        { type: 'fileEmbed', attrs: { nodeId: OK, filename: 'shared.pdf' } },
        // An external image is refused like any other refused ref (B25).
        { type: 'blockquote', content: [{ type: 'paragraph' }] },
      ),
    );
    expect(json(out)).not.toContain('Team chart');
    expect(json(out)).not.toContain('Admin notes');
  });

  it('keeps every reference to a readable item exactly as it was', () => {
    const input = doc(
      para(
        { type: 'mention', attrs: { id: OK, label: 'Shared plan', ref: 'node' } },
        text('open', link(`/n/${OK2}`)),
        text('site', link('https://example.invalid/')),
      ),
      { type: 'image', attrs: { nodeId: OK } },
      { type: 'childPage', attrs: { pageId: OK2, title: 'Shared child' } },
    );
    const before = json(input);
    expect(redactClientDoc(input, readable)).toEqual(input);
    expect(json(input)).toBe(before); // the input is not changed
  });

  it('reaches references nested in lists, tables, callouts and columns', () => {
    const out = json(
      redactClientDoc(
        doc({
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                para(text('Admin title', link(`/n/${ADMIN}`))),
                {
                  type: 'table',
                  content: [
                    {
                      type: 'tableRow',
                      content: [
                        {
                          type: 'tableCell',
                          content: [
                            {
                              type: 'callout',
                              content: [
                                para({
                                  type: 'mention',
                                  attrs: { id: TEAM, label: 'Deep secret', ref: 'node' },
                                }),
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }),
        readable,
      ),
    );
    expect(out).not.toContain('Admin title');
    expect(out).not.toContain('Deep secret');
    expect(out).not.toContain(TEAM);
    expect(out).not.toContain(ADMIN);
  });

  it('collects the ids to ask about', () => {
    expect(
      docRefIds(
        doc(para(text('x', link(`/n/${TEAM}`))), { type: 'image', attrs: { nodeId: OK } }),
      ).sort(),
    ).toEqual([OK, TEAM].sort());
  });
});

describe('redactClientNote', () => {
  it('turns a /n/ link to a hidden item into "Private item"', () => {
    expect(redactClientNote(`Read [Team roadmap](/n/${TEAM}) first.`, readable)).toBe(
      `Read ${CLIENT_PRIVATE_LABEL} first.`,
    );
  });

  it('handles every internal form: mention, page, media, draw, a title, angle brackets', () => {
    const md = [
      `[Pat Lee](mention:node:${TEAM})`,
      `[Plan](page:${ADMIN} "Admin plan")`,
      `![Chart](media:${TEAM})`,
      `![Sketch](draw:${ADMIN})`,
      `[Spec](</n/${TEAM}>)`,
      `[Who](mention:entity:ent-9)`,
    ].join('\n\n');
    const out = redactClientNote(md, readable);
    for (const s of [
      'Pat Lee',
      'Plan',
      'Admin plan',
      'Chart',
      'Sketch',
      'Spec',
      'Who',
      TEAM,
      ADMIN,
    ]) {
      expect(out).not.toContain(s);
    }
    expect(out.split(CLIENT_PRIVATE_LABEL).length - 1).toBe(4);
  });

  it('keeps readable and external links untouched', () => {
    const md = `[Shared](/n/${OK}) and ![pic](media:${OK2}) and [site](https://example.invalid)`;
    expect(redactClientNote(md, readable)).toBe(md);
  });

  it('falls back to the document path for a form the line pass misses', () => {
    const md = `See [the [team] roadmap][r] now.\n\n[r]: /n/${TEAM}\n`;
    const out = redactClientNote(md, readable);
    expect(out).not.toContain('roadmap');
    expect(out).not.toContain(TEAM);
    expect(out).toContain(CLIENT_PRIVATE_LABEL);
    expect(noteRefIds(out)).toEqual([]);
  });
});

describe('fail closed and fresh labels (audit B25)', () => {
  const own = clientOwnUrl(['https://brain.example.invalid']);

  it('hides every refused reference, not only an entity mention', () => {
    const out = json(
      redactClientDoc(
        doc(
          para(
            text('JSLINK', link('javascript:alert(1)')),
            text('ODDSCHEME', link(`foo:${TEAM}`)),
            text('BADID', link('page:not-a-uuid')),
          ),
          { type: 'image', attrs: { src: 'https://tracker.example.invalid/p.png', alt: 'EXTIMG' } },
        ),
        readable,
      ),
    );
    for (const leak of ['JSLINK', 'ODDSCHEME', 'BADID', 'EXTIMG', 'tracker']) {
      expect(out, leak).not.toContain(leak);
    }
    expect(out.split(CLIENT_PRIVATE_LABEL).length - 1).toBe(3);
  });

  it('reads a scheme case-insensitively: PAGE: and MEDIA: are page: and media:', () => {
    const out = json(
      redactClientDoc(
        doc(para(text('UPPERTEAM', link(`PAGE:${TEAM}`)), text('UPPEROK', link(`PAGE:${OK}`))), {
          type: 'image',
          attrs: { src: `MEDIA:${ADMIN}`, alt: 'UPPERIMG' },
        }),
        readable,
      ),
    );
    expect(out).not.toContain('UPPERTEAM');
    expect(out).not.toContain('UPPERIMG');
    expect(out).toContain('UPPEROK');
    expect(docRefIds(doc(para(text('x', link(`PAGE:${OK}`)))))).toEqual([OK]);
    const note = redactClientNote(`[Plan](PAGE:${TEAM}) and ![p](Media:${ADMIN})`, readable);
    expect(note).toBe(`${CLIENT_PRIVATE_LABEL} and `);
  });

  it('reads an absolute URL into this brain as its path', () => {
    const d = doc(
      para(
        text('OWNHOST', link(`https://brain.example.invalid/pages/${TEAM}`)),
        text('HTTPOWN', link(`http://brain.example.invalid/n/${ADMIN}`)),
        text('PERMALINK', link(`https://elsewhere.example.invalid/n/${TEAM}`)),
        text('OWNOK', link(`https://brain.example.invalid/n/${OK}`)),
        text('EXTERNAL', link(`https://example.invalid/docs/${TEAM}`)),
      ),
    );
    const out = json(redactClientDoc(d, readable, { ownUrl: own }));
    for (const leak of ['OWNHOST', 'HTTPOWN', 'PERMALINK', ADMIN]) {
      expect(out, leak).not.toContain(leak);
    }
    expect(out).toContain('OWNOK');
    expect(out).toContain('EXTERNAL');
    expect(docRefIds(d, { ownUrl: own }).sort()).toEqual([OK, TEAM, ADMIN].sort());
    // Without the brain's host, the /n/ permalink rule still holds.
    expect(json(redactClientDoc(d, readable))).not.toContain('PERMALINK');
    expect(
      redactClientNote(`[x](https://brain.example.invalid/n/${TEAM}) ok`, readable, {
        ownUrl: own,
      }),
    ).toBe(`${CLIENT_PRIVATE_LABEL} ok`);
  });

  it("refreshes a readable chip and child page card from today's titles", () => {
    const titles = new Map([
      [OK, 'Plan today'],
      [OK2, 'Child today'],
    ]);
    const out = redactClientDoc(
      doc(para({ type: 'mention', attrs: { id: OK, label: 'Plan old', ref: 'node' } }), {
        type: 'childPage',
        attrs: { pageId: OK2, title: 'Child old' },
      }),
      readable,
      { titles },
    );
    expect(out).toEqual(
      doc(para({ type: 'mention', attrs: { id: OK, label: 'Plan today', ref: 'node' } }), {
        type: 'childPage',
        attrs: { pageId: OK2, title: 'Child today' },
      }),
    );
    expect(
      redactClientNote(
        `[Plan old](mention:node:${OK}) and [Child old](page:${OK2}) and [keep](/n/${OK})`,
        readable,
        { titles: new Map([...titles, [OK2, 'Child [today]']]) },
      ),
    ).toBe(
      `[Plan today](mention:node:${OK}) and [Child \\[today\\]](page:${OK2}) and [keep](/n/${OK})`,
    );
  });

  it('can keep a hidden child page as "Private item" (the level-filtered text)', () => {
    const d = doc({ type: 'childPage', attrs: { pageId: TEAM, title: 'Team child' } });
    expect(redactClientDoc(d, readable)).toEqual(doc({ type: 'paragraph' }));
    expect(redactClientDoc(d, readable, { hiddenChildPage: 'label' })).toEqual(
      doc({ type: 'childPage', attrs: { pageId: null, title: CLIENT_PRIVATE_LABEL } }),
    );
  });

  it('table cells: a reference the client may not read reads "Private item"', () => {
    const cells = [
      `/n/${TEAM}`,
      `PAGE:${ADMIN}`,
      `/n/${OK}`,
      'plain text',
      `See /n/${TEAM}`,
      42,
      null,
      [`/n/${TEAM}`, 'tag'],
    ];
    expect(cellRefIds(cells).sort()).toEqual([OK, TEAM, ADMIN].sort());
    expect(cells.map((c) => redactClientCell(c, readable))).toEqual([
      CLIENT_PRIVATE_LABEL,
      CLIENT_PRIVATE_LABEL,
      `/n/${OK}`,
      'plain text',
      `See /n/${TEAM}`,
      42,
      null,
      [CLIENT_PRIVATE_LABEL, 'tag'],
    ]);
    expect(
      redactClientCell(`https://brain.example.invalid/x/${TEAM}`, readable, { ownUrl: own }),
    ).toBe(CLIENT_PRIVATE_LABEL);
  });

  it('drawing links: which ids they name, which are hidden', () => {
    const hrefs = [`/n/${TEAM}`, `/n/${OK}`, 'https://example.invalid/', `mention:entity:e1`];
    expect(linkRefIds(hrefs).sort()).toEqual([OK, TEAM].sort());
    expect(hrefs.map((h) => clientLinkHidden(h, readable))).toEqual([true, false, false, true]);
  });
});
