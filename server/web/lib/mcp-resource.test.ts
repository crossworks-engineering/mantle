/**
 * Which `resource` values name this box's MCP endpoint (RFC 8707), and
 * what a log line repeats of a value that does not. Nothing here refuses:
 * lib/mcp-resource.ts only logs.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  canonicalResource,
  foreignResource,
  noteResource,
  resourceNamesThisBox,
} from './mcp-resource';

let warn: MockInstance<typeof console.warn>;
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

describe('foreignResource', () => {
  it('is null for no value, or values that all name the box', () => {
    expect(foreignResource([])).toBeNull();
    expect(foreignResource(['https://brain.example/api/mcp', 'https://brain.example'])).toBeNull();
  });
  it('answers the first value that names another server', () => {
    expect(foreignResource(['https://brain.example/api/mcp', 'https://a.example/mcp'])).toBe(
      'https://a.example/mcp',
    );
  });
  it('checks the first four text values only, and skips a file', () => {
    const many = [...Array(4).fill('https://brain.example/api/mcp'), 'https://a.example/mcp'];
    expect(foreignResource(many)).toBeNull();
    expect(foreignResource([new Blob(['x']), 'https://a.example/mcp'])).toBe(
      'https://a.example/mcp',
    );
  });
});

describe('noteResource', () => {
  it('logs nothing for no value or a value that names the box', () => {
    noteResource([], 'refresh');
    noteResource(['https://brain.example/api/mcp'], 'code exchange');
    expect(warn).not.toHaveBeenCalled();
  });
  it('logs one line per request, clipped and printable', () => {
    noteResource([`https://b.example/${'y'.repeat(400)}\n`, 'https://a.example/x'], 'refresh');
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain('at refresh');
    expect(line).not.toContain('\n');
    expect(line).toContain('...');
    expect(line.length).toBeLessThan(400);
    warn.mockClear();
    noteResource(['https://a.example/x\n[mcp-oauth] forged line'], 'code exchange');
    expect(String(warn.mock.calls[0]![0])).toContain('/x?[mcp-oauth] forged line');
  });
  it('logs one line for a request with thousands of values', () => {
    noteResource(Array(10_000).fill('https://a.example/x'), 'refresh');
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it('skips a value that is not text (a file in a form)', () => {
    noteResource([new Blob(['x'])], 'code exchange');
    expect(warn).not.toHaveBeenCalled();
  });
});
