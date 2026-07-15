import { describe, expect, it } from 'vitest';
import {
  chunkSpreadsheetProfile,
  hasSheetMarkers,
  isSpreadsheetTitle,
} from './chunk-spreadsheet';

const grid = (rows: number, prefix = 'r') =>
  Array.from({ length: rows }, (_, i) => `${prefix}${i + 1},10,20,30`).join('\n');

describe('hasSheetMarkers', () => {
  it('detects parseXlsx output', () => {
    expect(hasSheetMarkers('# Sheet: Data\na,b,c\n1,2,3')).toBe(true);
  });
  it('rejects ordinary markdown and prose', () => {
    expect(hasSheetMarkers('# Heading\nsome text')).toBe(false);
    expect(hasSheetMarkers('plain text body')).toBe(false);
  });
});

describe('isSpreadsheetTitle', () => {
  it('matches grid extensions, case-insensitively', () => {
    for (const t of ['a.xlsx', 'B.XLSM', 'c.xls', 'd.xlsb', 'e.csv']) {
      expect(isSpreadsheetTitle(t)).toBe(true);
    }
  });
  it('rejects documents', () => {
    for (const t of ['a.pdf', 'b.docx', 'notes.md', 'archive.csv.gpg']) {
      expect(isSpreadsheetTitle(t)).toBe(false);
    }
  });
});

describe('chunkSpreadsheetProfile', () => {
  it('emits ONE profile chunk per sheet, not one per row-window', () => {
    const text = `# Sheet: Alpha\nname,qty\n${grid(500)}\n# Sheet: Beta\nid,val\n${grid(300, 'b')}`;
    const chunks = chunkSpreadsheetProfile(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.headingPath).toBe('Sheet: Alpha');
    expect(chunks[1]!.headingPath).toBe('Sheet: Beta');
  });

  it('keeps the header row, samples data rows, and states honest coverage', () => {
    const text = `# Sheet: Data\ncol_a,col_b\n${grid(100)}`;
    const [chunk] = chunkSpreadsheetProfile(text, { sampleRows: 5 });
    expect(chunk!.text).toContain('Columns: col_a,col_b');
    expect(chunk!.text).toContain('r5,10,20,30');
    expect(chunk!.text).not.toContain('r6,10,20,30');
    expect(chunk!.text).toContain('5 of 100 data rows shown');
    expect(chunk!.text).toContain('file_read');
  });

  it('says so when the sample covers everything', () => {
    const text = `# Sheet: Tiny\na,b\n1,2\n3,4`;
    const [chunk] = chunkSpreadsheetProfile(text, { sampleRows: 8 });
    expect(chunk!.text).toContain('all 2 data rows shown');
  });

  it('treats a markerless body as one sheet named for the file (bare CSV)', () => {
    const chunks = chunkSpreadsheetProfile(`a,b,c\n${grid(50)}`, {
      fileTitle: 'asset_register.csv',
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.headingPath).toBe('Sheet: asset_register');
  });

  it('caps a profile at maxChars even with a huge header row', () => {
    const text = `# Sheet: Wide\n${'col,'.repeat(3000)}\n1,2,3`;
    const [chunk] = chunkSpreadsheetProfile(text, { maxChars: 500 });
    expect(chunk!.text.length).toBeLessThanOrEqual(500);
  });

  it('returns [] for an empty body (same contract as chunkDocText)', () => {
    expect(chunkSpreadsheetProfile('')).toEqual([]);
    expect(chunkSpreadsheetProfile('   \n  ')).toEqual([]);
  });
});
