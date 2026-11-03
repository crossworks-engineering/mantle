/**
 * The shell's peer link (scripts/peer-link.ts): a token never rides argv,
 * the flags combine only as documented, the other box's token is read
 * strictly and its content never repeated in an error, and a peer is found
 * by id or by name. The database side runs in peer-link.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { findPeer, parseArgs, scopeOf, tokenFromText } from './peer-link';

describe('peer-link arguments', () => {
  it('refuses a token on the command line, by name', () => {
    for (const flag of ['--token', '--outbound-token', '--inbound-token', '--secret']) {
      expect(() => parseArgs(['accept', '--peer', 'a', flag, 'mtlpeer_x'])).toThrow(
        /never goes on/,
      );
      expect(() => parseArgs(['accept', '--peer', 'a', `${flag}=mtlpeer_x`])).toThrow(
        /never goes on/,
      );
    }
  });

  it('create needs a name and a URL; one of status-only and outbound-only', () => {
    expect(() => parseArgs(['create', '--url', 'https://a.example.com'])).toThrow(/--name/);
    expect(() => parseArgs(['create', '--name', 'a'])).toThrow(/--url/);
    expect(() =>
      parseArgs([
        'create',
        '--name',
        'a',
        '--url',
        'https://a.example.com',
        '--status-only',
        '--outbound-only',
      ]),
    ).toThrow(/pick one/);
    const o = parseArgs([
      'create',
      '--name=admin',
      '--url',
      'https://a.example.com',
      '--status-only',
    ]);
    expect(o).toMatchObject({ command: 'create', name: 'admin', statusOnly: true });
    expect(scopeOf(o)).toBe('status');
    expect(scopeOf({ statusOnly: false, outboundOnly: true })).toBe('none');
    expect(scopeOf({ statusOnly: false, outboundOnly: false })).toBe('full');
  });

  it('refuses a plain http URL unless --allow-http, and anything but http(s)', () => {
    expect(() => parseArgs(['create', '--name', 'a', '--url', 'http://a.example.com'])).toThrow(
      /plain http/,
    );
    expect(
      parseArgs(['create', '--name', 'a', '--url', 'http://localhost:3000', '--allow-http'])
        .allowHttp,
    ).toBe(true);
    expect(() => parseArgs(['create', '--name', 'a', '--url', 'ftp://a.example.com'])).toThrow(
      /https/,
    );
    expect(() => parseArgs(['list', '--allow-http'])).toThrow(/for create/);
  });

  it('the create flags are for create; accept and revoke name a peer', () => {
    expect(() => parseArgs(['list', '--watch'])).toThrow(/for create/);
    expect(() => parseArgs(['accept'])).toThrow(/--peer/);
    expect(() => parseArgs(['revoke'])).toThrow(/--peer/);
    expect(() => parseArgs(['list', '--token-file', 'x'])).toThrow(/for accept/);
    expect(() => parseArgs([])).toThrow(/Name a command/);
    expect(() => parseArgs(['delete'])).toThrow(/Unknown command/);
    expect(parseArgs(['--help']).help).toBe(true);
  });
});

describe("the other box's token", () => {
  it('takes the first non-empty line, and a create line as printed', () => {
    expect(tokenFromText('\n  mtlpeer_abc123  \nsecond\n')).toBe('mtlpeer_abc123');
    expect(tokenFromText('token=mtlpeer_abc123\r\n')).toBe('mtlpeer_abc123');
    // A create's whole output piped across: its token line.
    expect(tokenFromText('peer_id=p1\ntoken=mtlpeer_abc123\n')).toBe('mtlpeer_abc123');
  });

  it('refuses what is not a peer token, without repeating it', () => {
    for (const bad of ['', '\n\n', 'hunter2-secret', 'mtlpeer_has space']) {
      let message = '';
      try {
        tokenFromText(bad);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, bad).not.toBe('');
      if (bad.trim()) expect(message).not.toContain(bad.trim());
    }
  });
});

describe('finding a peer', () => {
  const row = (id: string, displayName: string) =>
    ({ id, displayName }) as unknown as Parameters<typeof findPeer>[0][number];
  const peers = [row('p1', 'Admin'), row('p2', 'box1'), row('p3', 'twin'), row('p4', 'Twin')];

  it('by id, or by name in any case; two of a name ask for the id', () => {
    expect(findPeer(peers, 'p2')).toMatchObject({ id: 'p2' });
    expect(findPeer(peers, 'admin')).toMatchObject({ id: 'p1' });
    expect(findPeer(peers, 'twin')).toEqual({ error: expect.stringMatching(/use its id/) });
    expect(findPeer(peers, 'nope')).toEqual({ error: expect.stringMatching(/No peer/) });
  });
});
