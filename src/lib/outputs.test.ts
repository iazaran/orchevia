import { describe, expect, it } from 'vitest';
import {
  canOpenFile,
  fileKindOf,
  formatBytes,
  previewDataUrl,
  workspaceFolder,
  workspaceFolderName,
} from './outputs';

describe('run files', () => {
  // Shared with `kinds_follow_the_extension` in crates/core/src/outputs.rs.
  it('reads the kind from the extension like the desktop app', () => {
    const cases: [string, string][] = [
      ['cover.PNG', 'image'],
      ['a/b/shot.webp', 'image'],
      ['logo.svg', 'image'],
      ['clip.mp4', 'video'],
      ['clip.webm', 'video'],
      ['voice.mp3', 'audio'],
      ['deck.pdf', 'pdf'],
      ['post.md', 'markdown'],
      ['data.csv', 'text'],
      ['page.html', 'text'],
      ['brief.docx', 'document'],
      ['archive.zip', 'other'],
      ['Makefile', 'other'],
      ['.env', 'other'],
    ];
    for (const [name, kind] of cases) expect(fileKindOf(name), name).toBe(kind);
  });

  it('never offers to open scripts or programs', () => {
    expect(canOpenFile('x.mp4')).toBe(true);
    expect(canOpenFile('x.csv')).toBe(true);
    for (const name of [
      'run.sh',
      'tool.py',
      'app.js',
      'x.desktop',
      'x.command',
      'x.exe',
      'page.html',
      'feed.xml',
    ])
      expect(canOpenFile(name), name).toBe(false);
  });

  it('formats sizes and data URLs', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB');
    expect(
      previewDataUrl({
        path: '/x.png',
        kind: 'image',
        mime: 'image/png',
        size: 4,
        base64: 'iVBORw==',
        truncated: false,
      }),
    ).toBe('data:image/png;base64,iVBORw==');
    expect(
      previewDataUrl({
        path: '/x.mp4',
        kind: 'video',
        mime: 'video/mp4',
        size: 9e9,
        truncated: true,
      }),
    ).toBeNull();
  });
});

describe('workspace folders', () => {
  // Shared with `folder_names_are_readable_and_safe` in crates/core/src/workspace.rs.
  it('names folders like the desktop app', () => {
    const cases: [string, string, string][] = [
      ['Blog Post from a Brief', 'wf-mwxtc6717ulqfo', 'Blog Post from a Brief (7ulqfo)'],
      ['a/b\\c:d', 'wf-1', 'a-b-c-d (wf1)'],
      ['../escape', 'x', 'escape (x)'],
      ['  ..hidden  ', 'ABCdef123', 'hidden (def123)'],
      ['Tabs\tand\nnewlines', 'wf', 'Tabs-and-newlines (wf)'],
      ['Résumé ✨ kit', 'wf', 'Résumé - kit (wf)'],
      ['///', 'wf-7', 'Workflow (wf7)'],
      ['...', '..', 'Workflow'],
      ['trailing dots...', 'wf', 'trailing dots (wf)'],
    ];
    for (const [name, id, expected] of cases)
      expect(workspaceFolderName(name, id), name).toBe(expected);
    expect(Array.from(workspaceFolderName('x'.repeat(200), 'abc'))).toHaveLength(86);
    expect(workspaceFolderName('Same', 'wf-aaaaaa')).not.toBe(
      workspaceFolderName('Same', 'wf-bbbbbb'),
    );
  });

  it('joins the root and the folder name', () => {
    expect(
      workspaceFolder('/home/me/Documents/Orchevia/', 'Launch kit / spring', 'w'),
    ).toBe('/home/me/Documents/Orchevia/Launch kit - spring (w)');
  });
});
