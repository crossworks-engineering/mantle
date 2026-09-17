/**
 * Tables · workbook shape guards. Five pure-ish helpers that answer "what am I
 * actually about to overwrite" before a whole-doc write lands.
 *
 * `guardSingleTabWrite` is the important one: a bare single-tab doc written
 * against a multi-tab workbook would silently drop every other tab, so the
 * write is refused rather than reshaped.
 */
import { existsSync } from 'node:fs';
import { fileStats, resolveStoragePath, type WorkbookStats } from '@mantle/tabledb';
import type { TableDoc, WorkbookDoc } from '@mantle/content-core/table-model';
import { draftAbsFor } from '../table-storage';
import { TAB_NAME } from './shared';

/** A workbook (multi-tab) write shape, vs a bare single-tab doc. */
export function isWorkbook(data: TableDoc | WorkbookDoc): data is WorkbookDoc {
  return 'tabs' in data && Array.isArray((data as WorkbookDoc).tabs);
}

/** Refuse a bare single-tab doc against a multi-tab workbook: writing it
 *  whole would silently DROP every other tab. Tab-aware callers pass a
 *  WorkbookDoc; per-tab editors use draft ops with a tabId. */
export function guardSingleTabWrite(tabCount: number): void {
  if (tabCount > 1) {
    throw new Error(
      'this table is a multi-tab workbook — a whole-grid save would drop the other tabs; edit via draft ops (tabId) or send the full workbook',
    );
  }
}

/** Stats of a workbook file, or null when it is unreadable/absent. */
export function statsOrNull(absPath: string): WorkbookStats | null {
  try {
    return existsSync(absPath) ? fileStats(absPath) : null;
  } catch {
    return null;
  }
}

/** The tab count a whole-doc write would actually clobber: the DRAFT's when
 *  one exists (registry stats only see the published file — a tab added by
 *  an import/draft op is invisible there; audit: a bare PUT could silently
 *  destroy draft-only tabs), else the published count from the locked row. */
export function effectiveTabCount(
  locked: { tabCount: number | null } | null,
  storagePath: string | null,
): number {
  if (storagePath) {
    const draftStats = statsOrNull(draftAbsFor(storagePath));
    if (draftStats) return draftStats.tabs.length;
  }
  return locked?.tabCount ?? 1;
}

/** First tab's display name in draft-then-published order — bare-doc rebuilds
 *  must keep it (audit: the whole-doc fallback renamed "Inventory" back to
 *  'Sheet1', flipping the shape hash and forcing a re-summarize). */
export function effectiveTabName(storagePath: string | null): string {
  if (storagePath) {
    const name =
      statsOrNull(draftAbsFor(storagePath))?.tabs[0]?.name ??
      statsOrNull(resolveStoragePath(storagePath))?.tabs[0]?.name;
    if (name) return name;
  }
  return TAB_NAME;
}
