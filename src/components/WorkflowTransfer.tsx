import { useEffect, useMemo, useRef, useState } from 'react';
import { getBackend } from '../lib/backend';
import { errorMessage } from '../lib/errors';
import { checkJsonSyntax } from '../lib/json-syntax';
import { prepareImportText, toN8n } from '../lib/n8n';
import { arrangeWorkflowPositions, newId, type Workflow } from '../lib/workflow';
import { useAppStore } from '../store';
import { CopyButton } from './CopyButton';
import { JsonEditor, JsonView } from './JsonEditor';
import { Modal } from './Modal';
import { Notice } from './Notice';
import { Segmented } from './Segmented';

type Direction = 'export' | 'import';
type Format = 'orchevia' | 'n8n';

/**
 * Move workflows in and out of Orchevia: export the open workflow as Simple
 * JSON or n8n workflow JSON, or import either format as a new workflow.
 * Conversions list what changed so nothing is dropped silently, and imported
 * workflows still go through the normal validation before they run.
 */
export function WorkflowTransfer({
  workflow,
  initialDirection,
  onClose,
  onImport,
}: {
  workflow: Workflow | null;
  initialDirection?: Direction;
  onClose: () => void;
  /** Save the decoded workflow; resolves once it is stored and selected. */
  onImport: (workflow: Workflow, notes: string[]) => Promise<void>;
}): React.JSX.Element {
  const profiles = useAppStore((s) => s.profiles);
  const [direction, setDirection] = useState<Direction>(
    initialDirection ?? (workflow === null ? 'import' : 'export'),
  );
  const [format, setFormat] = useState<Format>('n8n');
  const [simple, setSimple] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (workflow === null || format !== 'orchevia') return;
    let alive = true;
    void getBackend()
      .encodeWorkflowDocument(workflow)
      .then((session) => {
        if (alive) {
          setSimple(session.json);
          setExportError(null);
        }
      })
      .catch((err: unknown) => {
        if (alive) setExportError(errorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [workflow, format]);

  const n8n = useMemo(
    () => (workflow === null ? null : toN8n(workflow, profiles)),
    [workflow, profiles],
  );
  const exported =
    format === 'n8n' ? JSON.stringify(n8n?.workflow ?? {}, null, 2) : (simple ?? '');

  const prepared = useMemo(() => prepareImportText(importText), [importText]);
  const syntaxError = useMemo(
    () => (importText.trim() === '' ? null : checkJsonSyntax(importText)),
    [importText],
  );

  const runImport = (): void => {
    if (importText.trim() === '') return;
    setBusy(true);
    setImportError(null);
    void (async () => {
      try {
        const decoded = await getBackend().decodeWorkflowDocument(prepared.json);
        const positions = arrangeWorkflowPositions(decoded.nodes, decoded.edges);
        // Always a new workflow, even when Advanced JSON carries an existing id.
        const arranged: Workflow = {
          ...decoded,
          id: newId('wf'),
          nodes: decoded.nodes.map((node) => ({
            ...node,
            position: positions[node.id] ?? node.position,
          })),
        };
        await onImport(arranged, prepared.notes);
      } catch (err) {
        setImportError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    })();
  };

  const openFile = (file: File | undefined): void => {
    if (file === undefined) return;
    if (file.size > 5 * 1024 * 1024) {
      setImportError(
        'That file is larger than 5 MB; workflow JSON is usually far smaller.',
      );
      return;
    }
    void file
      .text()
      .then((text) => {
        setImportText(text);
        setImportError(null);
      })
      .catch((err: unknown) => {
        setImportError(errorMessage(err));
      });
  };

  return (
    <Modal
      label="Import or export a workflow"
      onClose={onClose}
      closeLabel="Close import and export"
      onBackdrop={onClose}
      maxWidth={820}
    >
      <div className="transfer">
        <h3 style={{ marginTop: 0 }}>Import &amp; export</h3>
        <p className="field-hint">
          Share workflows as Orchevia JSON, or move them to and from <strong>n8n</strong>.
          Conversions list anything they change.
        </p>
        <div className="transfer-switches">
          <Segmented
            label="Direction"
            value={direction}
            onChange={setDirection}
            options={[
              { value: 'export', label: 'Export' },
              { value: 'import', label: 'Import' },
            ]}
          />
          {direction === 'export' && (
            <Segmented
              label="Export format"
              value={format}
              onChange={setFormat}
              options={[
                {
                  value: 'n8n',
                  label: 'n8n workflow',
                  title: 'Paste into an n8n canvas',
                },
                {
                  value: 'orchevia',
                  label: 'Orchevia Simple JSON',
                  title: 'Readable steps and connections for another Orchevia',
                },
              ]}
            />
          )}
        </div>

        {direction === 'export' &&
          (workflow === null ? (
            <p className="field-hint">Select a workflow on the canvas to export it.</p>
          ) : (
            <>
              {format === 'n8n' && (
                <p className="field-hint">
                  In n8n, open an empty workflow and paste (Ctrl+V or ⌘V) onto the canvas,
                  or save the JSON as a <code>.json</code> file and use{' '}
                  <em>Import from File</em>.
                </p>
              )}
              {exportError !== null ? (
                <Notice variant="error" inline>
                  {exportError}
                </Notice>
              ) : (
                <JsonView value={exported} className="transfer-output" />
              )}
              {format === 'n8n' && n8n !== null && n8n.notes.length > 0 && (
                <div className="transfer-notes">
                  <span className="field-label">What changes in n8n</span>
                  <ul>
                    {n8n.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="modal-actions">
                <CopyButton
                  className="btn btn-primary"
                  text={exported}
                  label={format === 'n8n' ? 'Copy n8n JSON' : 'Copy JSON'}
                  disabled={exported === '' || exportError !== null}
                />
                <button type="button" className="btn btn-ghost" onClick={onClose}>
                  Close
                </button>
              </div>
            </>
          ))}

        {direction === 'import' && (
          <>
            <div className="field">
              <div className="field-row">
                <label className="field-label" htmlFor="transfer-import">
                  Workflow JSON
                </label>
                {importText.trim() !== '' && (
                  <span
                    className={`format-badge ${prepared.source === 'n8n' ? 'is-n8n' : ''}`}
                  >
                    {prepared.source === 'n8n' ? 'n8n workflow' : 'Orchevia JSON'}
                  </span>
                )}
              </div>
              <JsonEditor
                id="transfer-import"
                rows={12}
                allowEmpty
                value={importText}
                onChange={(next) => {
                  setImportText(next);
                  setImportError(null);
                }}
              />
              <span className="field-hint">
                Paste an n8n workflow (select nodes in n8n and copy, or download it) or
                Orchevia Simple/Advanced JSON.
              </span>
            </div>
            {prepared.source === 'n8n' && prepared.notes.length > 0 && (
              <div className="transfer-notes">
                <span className="field-label">Conversion notes</span>
                <ul>
                  {prepared.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </div>
            )}
            {importError !== null && (
              <Notice variant="error" inline style={{ marginBottom: 12 }}>
                {importError}
              </Notice>
            )}
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                openFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || importText.trim() === '' || syntaxError !== null}
                onClick={runImport}
              >
                {busy ? 'Importing…' : 'Create workflow'}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => fileInput.current?.click()}
              >
                Open file…
              </button>
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
