/**
 * Files a run made and workspace folders (v0.4.0). Mirrors
 * `crates/core/src/outputs.rs` and `crates/core/src/workspace.rs`.
 */

export type RunFileKind =
  'image' | 'video' | 'audio' | 'pdf' | 'markdown' | 'text' | 'document' | 'other';

export interface RunFile {
  path: string;
  /** The run folder the file was found in. */
  folder: string;
  relPath: string;
  size: number;
  modifiedAt: string;
  kind: RunFileKind;
}

export interface RunFiles {
  folders: string[];
  files: RunFile[];
  /** More files changed than are listed. */
  truncated: boolean;
}

export interface RunFilePreview {
  path: string;
  kind: RunFileKind;
  mime: string;
  size: number;
  text?: string;
  base64?: string;
  /** Text cut at 512 KiB, or media too large to show inline (20 MiB). */
  truncated: boolean;
}

/**
 * Media and document tools the desktop app detects (mirrors Rust
 * `tools::MEDIA_TOOL_IDS`), with how to install each one.
 */
export const MEDIA_TOOLS = [
  {
    id: 'ffmpeg',
    name: 'FFmpeg',
    use: 'Cut, resize, convert and caption video and audio.',
    install: 'sudo apt install ffmpeg · brew install ffmpeg',
  },
  {
    id: 'imagemagick',
    name: 'ImageMagick',
    use: 'Resize, crop, convert and watermark images.',
    install: 'sudo apt install imagemagick · brew install imagemagick',
  },
  {
    id: 'pandoc',
    name: 'Pandoc',
    use: 'Turn Markdown into Word, PDF, slides or HTML.',
    install: 'sudo apt install pandoc · brew install pandoc',
  },
  {
    id: 'python',
    name: 'Python',
    use: 'Lets agents analyze spreadsheets and draw charts.',
    install: 'sudo apt install python3 · brew install python',
  },
] as const;

export type MediaToolId = (typeof MEDIA_TOOLS)[number]['id'];

/** Setting holding an absolute workspace root; blank means the default. */
export const WORKSPACE_ROOT_SETTING = 'workspace.root';

/** Longest saved workspace root, in bytes (mirrors `MAX_ROOT_BYTES`). */
export const MAX_WORKSPACE_ROOT_BYTES = 1024;

/** Blank (the default) or an absolute path on one line, else the reason. */
export function validateWorkspaceRoot(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (
    new TextEncoder().encode(value).length > MAX_WORKSPACE_ROOT_BYTES ||
    /[\0\n\r]/.test(value)
  )
    return 'The workspace folder must be one line of at most 1024 bytes.';
  if (!trimmed.startsWith('/')) return 'The workspace folder must be an absolute path.';
  return null;
}

const KINDS: Record<string, RunFileKind> = {};
const assign = (kind: RunFileKind, extensions: string): void => {
  for (const ext of extensions.split(' ')) KINDS[ext] = kind;
};
assign('image', 'png jpg jpeg gif webp svg avif bmp ico');
assign('video', 'mp4 webm mov m4v mkv ogv avi');
assign('audio', 'mp3 wav ogg oga m4a flac aac opus');
assign('pdf', 'pdf');
assign('markdown', 'md markdown mdx');
assign(
  'text',
  'txt csv tsv json jsonl yaml yml toml xml html htm css js mjs ts tsx jsx py rs go rb java kt swift c h cpp sh sql log ini cfg conf srt vtt tex rst adoc php vue svelte',
);
assign('document', 'docx doc xlsx xls pptx ppt odt ods odp rtf epub key pages numbers');

/** What a file is, by its extension (mirrors Rust `outputs::kind_of`). */
export function fileKindOf(path: string): RunFileKind {
  const name = path.split(/[/\\]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'other';
  return KINDS[name.slice(dot + 1).toLowerCase()] ?? 'other';
}

/** Kinds the app opens with the default app (scripts never are). */
export function canOpenFile(path: string): boolean {
  const kind = fileKindOf(path);
  if (kind === 'other') return false;
  if (kind !== 'text') return true;
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  // Web pages and XML would open in a browser running their scripts.
  return 'txt csv tsv json yaml yml srt vtt log'.split(' ').includes(ext);
}

/** `1.2 MB`-style size. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${String(Math.max(0, bytes))} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit] ?? 'GB'}`;
}

/** A `data:` URL for previewed media, or null when there is no content. */
export function previewDataUrl(preview: RunFilePreview): string | null {
  if (preview.base64 === undefined) return null;
  return `data:${preview.mime};base64,${preview.base64}`;
}

const FOLDER_NAME_MAX = 80;
const ID_SUFFIX_CHARS = 6;

/**
 * The folder name a workflow gets under the workspace root (mirrors Rust
 * `workspace::folder_name`): separators and control characters become `-`,
 * no leading dots, at most 80 characters, then the last six letters or
 * digits of its id in brackets so same-named workflows never share a folder.
 */
export function workspaceFolderName(name: string, id: string): string {
  const mapped = Array.from(name)
    .map((c) => (/^[\p{Alphabetic}\p{N} \-_.()+]$/u.test(c) ? c : '-'))
    .join('');
  const collapsed = mapped.split(' ').filter(Boolean).join(' ');
  const trimmed = collapsed.replace(/^[. -]+/, '');
  const truncated = Array.from(trimmed).slice(0, FOLDER_NAME_MAX).join('');
  const base = truncated.replace(/[. ]+$/, '') || 'Workflow';
  const alnum = id.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  const suffix = alnum.slice(Math.max(0, alnum.length - ID_SUFFIX_CHARS));
  return suffix === '' ? base : `${base} (${suffix})`;
}

/** `<root>/<Workflow name>`, the folder folderless steps run in. */
export function workspaceFolder(root: string, name: string, id: string): string {
  return `${root.replace(/[/\\]+$/, '')}/${workspaceFolderName(name, id)}`;
}
