/**
 * Which `resource` values name this box's MCP endpoint (RFC 8707), and
 * what a log line repeats of a value that does not. Nothing here refuses:
 * lib/mcp-resource.ts only logs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalResource, noteResource, resourceNamesThisBox } from './mcp-resource';

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  process.env.MANTLE_PUBLIC_URL = 'https://brain.example';
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('canonicalResource', () => {
  it('lowercases the scheme and host, drops a default port and a trailing slash', () => {
    expect(canonicalResource('HTTPS://Brain.Example:443/api/mcp/')).toBe(
      'https://brain.example/api/mcp',
    );
  });
  it('is null for a value that is not an absolute URI', () => {
    expect(canonicalResource('brain.example/api/mcp')).toBeNull();
    expect(canonicalResource('')).toBeNull();
  });
});

describe('resourceNamesThisBox', () => {
  it('takes the MCP endpoint and the bare origin of the public URL', () => {
    for (const v of [
      'https://brain.example/api/mcp',
      'https://brain.example/api/mcp/',
      'https://BRAIN.example',
      'https://brain.example/',
    ]) {
      expect(resourceNamesThisBox(v), v).toBe(true);
    }
  });
  it('takes the origin the request came in on (an old host name)', () => {
    expect(resourceNamesThisBox('https://old-name.example/api/mcp')).toBe(false);
    expect(
      resourceNamesThisBox('https://old-name.example/api/mcp', 'https://old-name.example'),
    ).toBe(true);
  });
  it('refuses another path, another scheme, a query and a fragment', () => {
    for (const v of [
      'https://brain.example/api/other',
      'http://brain.example/api/mcp',
      'https://brain.example/api/mcp?x=1',
      'https://brain.example/api/mcp#f',
      'https://brain.example.evil.example/api/mcp',
    ]) {
      expect(resourceNamesThisBox(v), v).toBe(false);
    }
  });
});

describe('noteResource', () => {
  it('logs nothing for no value or a value that names the box', () => {
    noteResource([], 'authorize');
    noteResource(['https://brain.example/api/mcp'], 'authorize');
    expect(warn).not.toHaveBeenCalled();
  });
  it('logs each other value once, clipped and printable', () => {
    noteResource(['https://a.example/x', `https://b.example/${'y'.repeat(400)}\n`], 'refresh');
    expect(warn).toHaveBeenCalledTimes(2);
    const second = String(warn.mock.calls[1]![0]);
    expect(second).toContain('at refresh');
    expect(second).not.toContain('\n');
    expect(second).toContain('...');
    expect(second.length).toBeLessThan(400);
  });
  it('skips a value that is not text (a file in a form)', () => {
    noteResource([new Blob(['x'])], 'code exchange');
    expect(warn).not.toHaveBeenCalled();
  });
});
