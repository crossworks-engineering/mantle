import { describe, expect, it } from 'vitest';
import { fileFamilyKey } from './file-family';

describe('fileFamilyKey', () => {
  it('groups date-stamped weekly exports', () => {
    const a = fileFamilyKey('rem-work_cost-banner---30257_site_260208.xlsm');
    const b = fileFamilyKey('rem-work_cost-banner---30257_site_260215.xlsm');
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it('groups _version_NN workbooks across extensions', () => {
    expect(fileFamilyKey('supernova_version_02.xlsx')).toBe(
      fileFamilyKey('supernova_version_05.xlsm'),
    );
  });

  it('does NOT group single-digit distinctions (different documents, not versions)', () => {
    expect(fileFamilyKey('unit-1-drawing-v01.pdf')).not.toBe(
      fileFamilyKey('unit-2-drawing-v01.pdf'),
    );
  });

  it('returns null when there is no version signal (no ≥2-digit run)', () => {
    expect(fileFamilyKey('master-asset-list-template.xlsx')).toBeNull();
    expect(fileFamilyKey('unit-1-drawing.pdf')).toBeNull();
  });

  it('is case- and extension-insensitive', () => {
    expect(fileFamilyKey('Report_2026Q1.XLSX')).toBe(fileFamilyKey('report_2026q1.csv'));
  });
});
