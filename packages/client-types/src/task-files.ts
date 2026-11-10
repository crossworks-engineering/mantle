/**
 * A task file's caps and types (files on tasks, 2026-11-09). The server
 * holds them (packages/content/src/task-files.ts); the client reads them to
 * say no before an upload. Pure: no imports, so a browser bundle takes it.
 */

/** 10 MB per file. */
export const TASK_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** 5 files per task. */
export const TASK_FILES_MAX = 5;
/** Extensions a task file may have: images, PDF, text and logs. No svg or
 *  html: they can carry script. */
export const TASK_FILE_EXTS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'pdf',
  'txt',
  'log',
  'md',
  'json',
  'csv',
] as const;

/** The lower-case extension of `filename`, or '' when it has none. */
export function taskFileExt(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

/** May a file of this name be put on a task? */
export function isTaskFileType(filename: string): boolean {
  return (TASK_FILE_EXTS as readonly string[]).includes(taskFileExt(filename));
}
