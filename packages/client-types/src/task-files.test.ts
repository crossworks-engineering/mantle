import { describe, expect, it } from 'vitest';
import { isTaskFileType, taskFileExt, TASK_FILE_EXTS } from './task-files';

describe('task file types', () => {
  it('takes images, PDF, text and logs, by extension, in any case', () => {
    for (const name of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.pdf', 'g.log']) {
      expect(isTaskFileType(name)).toBe(true);
    }
    expect(TASK_FILE_EXTS).toContain('csv');
  });

  it('refuses svg, html, a name with no extension and a dot file', () => {
    for (const name of ['x.svg', 'x.html', 'x.htm', 'noext', '.png', 'x.png.exe']) {
      expect(isTaskFileType(name)).toBe(false);
    }
    expect(taskFileExt('Shot.PNG')).toBe('png');
  });
});
