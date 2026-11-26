import { useEffect, useMemo, useState } from 'react';
import { getBackend } from '../lib/backend';
import { errorMessage } from '../lib/errors';
import { MarkdownText } from './Markdown';
import { Modal } from './Modal';
import { Notice } from './Notice';
import { CopyButton } from './CopyButton';
import { Icon, type IconName } from './Icon';
import { formatTime } from '../lib/time';
import {
  canOpenFile,
  formatBytes,
  previewDataUrl,
  type RunFile,
  type RunFileKind,
  type RunFilePreview,
  type RunFiles,
} from '../lib/outputs';
import type { StoredRun } from '../lib/workflow';

const KIND_ICON: Record<RunFileKind, IconName> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  pdf: 'file',
  markdown: 'file',
  text: 'code',
  document: 'file',
  other: 'file',
};

const KIND_LABEL: Record<RunFileKind, string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  pdf: 'PDF',
  markdown: 'Document',
  text: 'Text',
  document: 'Office document',
  other: 'File',
};

/** Thumbnails are loaded for the first few images only. */
const THUMBNAIL_LIMIT = 12;

/** Thumbnails larger than this stay icons; the preview still shows them. */
const THUMBNAIL_MAX_BYTES = 4 * 1024 * 1024;

function fileName(file: RunFile): string {
  return file.relPath.split(/[/\\]/).pop() ?? file.relPath;
}

/**
 * What the run made: files its steps created or changed in the folders they
 * ran in, newest first, with previews of documents, images, audio and video.
 * `refreshKey` changes when a step finishes, so a live run's list grows.
 * Mount it with `key={run.id}` so another run starts from a clean state.
 */
export function RunFilesPanel({
  run,
  refreshKey,
}: {
  run: StoredRun;
  refreshKey: string;
}): React.JSX.Element | null {
  const [listing, setListing] = useState<RunFiles | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<RunFile | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getBackend()
      .listRunFiles(run.id)
      .then((next) => {
        if (!alive) return;
        setListing(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (alive) setError(errorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [run.id, run.status, run.finishedAt, refreshKey]);

  const images = useMemo(
    () =>
      (listing?.files ?? [])
        .filter((f) => f.kind === 'image' && f.size <= THUMBNAIL_MAX_BYTES)
        .slice(0, THUMBNAIL_LIMIT),
    [listing],
  );

  useEffect(() => {
    let alive = true;
    const missing = images.filter(
      (f) => thumbnails[`${f.path}@${f.modifiedAt}`] === undefined,
    );
    if (missing.length === 0) return;
    void Promise.all(
      missing.map(async (file) => {
        try {
          const preview = await getBackend().readRunFile(run.id, file.path);
          const url = previewDataUrl(preview);
          return url === null
            ? null
            : ([`${file.path}@${file.modifiedAt}`, url] as const);
        } catch {
          return null;
        }
      }),
    ).then((loaded) => {
      if (!alive) return;
      const entries = loaded.filter((entry) => entry !== null);
      if (entries.length > 0)
        setThumbnails((current) => ({ ...current, ...Object.fromEntries(entries) }));
    });
    return () => {
      alive = false;
    };
    // Thumbnails are keyed by path and time; re-reading them on every change
    // of the map would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images, run.id]);

  if (error !== null)
    return (
      <section aria-label="Run files" className="tool-card run-files">
        <h3>Files</h3>
        <Notice inline variant="warn">
          Could not list this run’s files: {error}
        </Notice>
      </section>
    );
  if (listing === null || listing.files.length === 0) return null;

  const act = (file: RunFile, reveal: boolean): void => {
    setActionError(null);
    getBackend()
      .openRunFile(run.id, file.path, reveal)
      .catch((err: unknown) => {
        setActionError(errorMessage(err));
      });
  };
  const visible = showAll ? listing.files : listing.files.slice(0, 12);
  const folders = listing.folders;
  return (
    <section aria-label="Run files" className="tool-card run-files">
      <div className="run-files-head">
        <h3>
          Files <span className="run-files-count">{listing.files.length}</span>
        </h3>
        <span className="field-hint" title={folders.join('\n')}>
          Created or changed during this run
          {folders.length === 1 ? (
            <>
              {' '}
              in <code>{folders[0]}</code>
            </>
          ) : (
            <> in {String(folders.length)} folders</>
          )}
          {listing.truncated && ' (newest shown)'}
        </span>
      </div>
      {actionError !== null && (
        <Notice
          inline
          variant="warn"
          onDismiss={() => {
            setActionError(null);
          }}
        >
          {actionError}
        </Notice>
      )}
      <ul className="run-files-grid">
        {visible.map((file) => {
          const thumb = thumbnails[`${file.path}@${file.modifiedAt}`];
          return (
            <li key={file.path}>
              <button
                type="button"
                className="run-file"
                onClick={() => {
                  setOpen(file);
                }}
                title={`${file.relPath}\n${formatBytes(file.size)} · ${formatTime(file.modifiedAt)}`}
                aria-label={`Preview ${file.relPath}`}
              >
                <span className={`run-file-thumb kind-${file.kind}`} aria-hidden="true">
                  {thumb === undefined ? (
                    <Icon name={KIND_ICON[file.kind]} size={26} />
                  ) : (
                    <img src={thumb} alt="" />
                  )}
                </span>
                <span className="run-file-name">{fileName(file)}</span>
                <span className="run-file-meta">
                  {KIND_LABEL[file.kind]} · {formatBytes(file.size)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {listing.files.length > 12 && (
        <button
          className="btn btn-ghost"
          onClick={() => {
            setShowAll((v) => !v);
          }}
        >
          {showAll ? 'Show fewer' : `Show all ${String(listing.files.length)} files`}
        </button>
      )}
      {open !== null && (
        <RunFileDialog
          key={`${open.path}@${open.modifiedAt}`}
          runId={run.id}
          file={open}
          onClose={() => {
            setOpen(null);
          }}
          onAct={act}
          actionError={actionError}
        />
      )}
    </section>
  );
}

function RunFileDialog({
  runId,
  file,
  onClose,
  onAct,
  actionError,
}: {
  runId: string;
  file: RunFile;
  onClose: () => void;
  onAct: (file: RunFile, reveal: boolean) => void;
  actionError: string | null;
}): React.JSX.Element {
  const [preview, setPreview] = useState<RunFilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    getBackend()
      .readRunFile(runId, file.path)
      .then((next) => {
        if (alive) setPreview(next);
      })
      .catch((err: unknown) => {
        if (alive) setError(errorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [runId, file.path, file.modifiedAt]);
  const url = preview === null ? null : previewDataUrl(preview);
  return (
    <Modal
      label={`File ${file.relPath}`}
      onClose={onClose}
      closeLabel="Close preview"
      onBackdrop={onClose}
      maxWidth={960}
    >
      <div className="run-file-dialog">
        <h3 className="run-file-title" title={file.path}>
          {file.relPath}
        </h3>
        <p className="field-hint">
          {KIND_LABEL[file.kind]} · {formatBytes(file.size)} · changed{' '}
          <span title={file.modifiedAt}>{formatTime(file.modifiedAt)}</span>
        </p>
        <div className="run-file-preview">
          {error !== null && (
            <Notice inline variant="warn">
              {error}
            </Notice>
          )}
          {error === null && preview === null && <p className="field-hint">Loading…</p>}
          {preview !== null && <PreviewBody preview={preview} url={url} />}
        </div>
        {actionError !== null && (
          <Notice inline variant="warn">
            {actionError}
          </Notice>
        )}
        <div className="run-file-actions">
          {canOpenFile(file.path) && (
            <button
              className="btn btn-primary"
              onClick={() => {
                onAct(file, false);
              }}
            >
              Open
            </button>
          )}
          <button
            className="btn"
            onClick={() => {
              onAct(file, true);
            }}
          >
            <Icon name="folder" size={15} /> Show in folder
          </button>
          <CopyButton text={file.path} label="Copy path" className="btn btn-ghost" />
          {preview?.text !== undefined && (
            <CopyButton text={preview.text} label="Copy text" className="btn btn-ghost" />
          )}
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}

function PreviewBody({
  preview,
  url,
}: {
  preview: RunFilePreview;
  url: string | null;
}): React.JSX.Element {
  if (preview.truncated && url === null && preview.text === undefined)
    return (
      <p className="field-hint">
        Too large to preview here ({formatBytes(preview.size)}). Open it, or show it in
        its folder.
      </p>
    );
  if (url !== null) {
    if (preview.kind === 'image')
      return <img className="run-file-media" src={url} alt={preview.path} />;
    if (preview.kind === 'video')
      return (
        <video className="run-file-media" src={url} controls preload="metadata">
          This video format cannot play here. Open it instead.
        </video>
      );
    if (preview.kind === 'audio') return <audio src={url} controls preload="metadata" />;
    if (preview.kind === 'pdf')
      return (
        <object className="run-file-pdf" data={url} type="application/pdf">
          <p className="field-hint">This PDF cannot show here. Open it instead.</p>
        </object>
      );
  }
  if (preview.text !== undefined) {
    return (
      <>
        {preview.kind === 'markdown' ? (
          <div className="report-full">
            <MarkdownText text={preview.text} />
          </div>
        ) : (
          <div className="log-block run-file-text">{preview.text}</div>
        )}
        {preview.truncated && (
          <p className="field-hint">
            Showing the first 512 KB. Open the file to see all of it.
          </p>
        )}
      </>
    );
  }
  return (
    <p className="field-hint">
      {preview.kind === 'document'
        ? 'Office documents open in their own app.'
        : 'No preview for this kind of file.'}{' '}
      {preview.kind === 'image' || preview.kind === 'video' || preview.kind === 'audio'
        ? 'The browser preview has no file to show.'
        : ''}
    </p>
  );
}
