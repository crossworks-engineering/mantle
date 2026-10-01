import { describe, expect, it } from 'vitest';
import { cleanSpaceFilename } from './member-space-files';

describe('cleanSpaceFilename', () => {
  it('keeps the last path segment and drops control characters', () => {
    expect(cleanSpaceFilename('../a/b\\Notes\u0007.TXT')).toBe('Notes.TXT');
    expect(cleanSpaceFilename('..')).toBeNull();
  });

  it('drops invisible direction and zero-width marks (audit S11)', () => {
    // Shown as "invoiceexe.pdf", really an .exe.
    expect(cleanSpaceFilename('invoice‮fdp.exe')).toBe('invoicefdp.exe');
    expect(cleanSpaceFilename('re​port⁦.pdf⁩﻿')).toBe('report.pdf');
    expect(cleanSpaceFilename('‎‏')).toBeNull();
  });
});
