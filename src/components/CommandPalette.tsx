import { useId, useMemo, useState } from 'react';
import { useAppStore, type View } from '../store';
import { Icon, type IconName } from './Icon';
import { Modal } from './Modal';

export interface PaletteCommand {
  id: string;
  label: string;
  /** Group shown on the right: Go to, Workflow, Template, Run, Action. */
  group: string;
  icon: IconName;
  /** Extra words that match, not shown. */
  keywords?: string;
  run: () => void;
}

/** Views the palette can open, in sidebar order. */
export const PALETTE_VIEWS: { id: View; label: string; icon: IconName }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'workflows', label: 'Workflows', icon: 'workflows' },
  { id: 'templates', label: 'Templates', icon: 'templates' },
  { id: 'runs', label: 'Runs', icon: 'runs' },
  { id: 'automations', label: 'Automations', icon: 'automations' },
  { id: 'agents', label: 'Agents', icon: 'agents' },
  { id: 'memory', label: 'Playbooks', icon: 'playbooks' },
  { id: 'environment', label: 'Environment', icon: 'environment' },
  { id: 'usage', label: 'Usage & costs', icon: 'usage' },
  { id: 'inbox', label: 'Inbox', icon: 'inbox' },
];

/** Every word of the query appears in the label, group or keywords. */
export function paletteMatches(command: PaletteCommand, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text =
    `${command.label} ${command.group} ${command.keywords ?? ''}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

const MAX_RESULTS = 40;

/**
 * Ctrl/⌘ + K: find a view, a workflow (open or run it), a template, a recent
 * run or an action, and draft a workflow from whatever was typed.
 */
export function CommandPalette({
  onClose,
  onOpenWizard,
}: {
  onClose: () => void;
  onOpenWizard: () => void;
}): React.JSX.Element {
  const workflows = useAppStore((s) => s.workflows);
  const runs = useAppStore((s) => s.runs);
  const builtinTemplates = useAppStore((s) => s.builtinTemplates);
  const userTemplates = useAppStore((s) => s.userTemplates);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();

  const commands = useMemo((): PaletteCommand[] => {
    const store = useAppStore.getState;
    const go = (view: View): void => {
      store().setView(view);
    };
    const names = new Map(workflows.map((w) => [w.id, w.name]));
    return [
      ...PALETTE_VIEWS.map((view) => ({
        id: `view-${view.id}`,
        label: view.label,
        group: 'Go to',
        icon: view.icon,
        run: () => {
          go(view.id);
        },
      })),
      {
        id: 'action-new',
        label: 'New workflow',
        group: 'Action',
        icon: 'plus' as const,
        keywords: 'create blank',
        run: () => {
          store().setPendingIntent({ kind: 'new' });
          go('workflows');
        },
      },
      {
        id: 'action-wizard',
        label: 'Open the setup wizard',
        group: 'Action',
        icon: 'check' as const,
        keywords: 'onboarding install sign in',
        run: onOpenWizard,
      },
      ...workflows.flatMap((workflow) => [
        {
          id: `open-${workflow.id}`,
          label: workflow.name,
          group: 'Workflow',
          icon: 'workflows' as const,
          keywords: 'open edit',
          run: () => {
            store().selectWorkflow(workflow.id);
            go('workflows');
          },
        },
        {
          id: `run-${workflow.id}`,
          label: `Run ${workflow.name}`,
          group: 'Workflow',
          icon: 'play' as const,
          keywords: 'start',
          run: () => {
            store().selectWorkflow(workflow.id);
            store().setPendingIntent({ kind: 'run' });
            go('workflows');
          },
        },
      ]),
      ...[...builtinTemplates, ...userTemplates].map((template) => ({
        id: `template-${template.id}`,
        label: template.name,
        group: 'Template',
        icon: 'templates' as const,
        keywords: `${template.category} ${template.description}`,
        run: () => {
          store().setTemplateDomain('all');
          store().setTemplateQuery(template.name);
          go('templates');
        },
      })),
      ...runs.slice(0, 10).map((run) => ({
        id: `past-run-${run.id}`,
        label: `${names.get(run.workflowId) ?? run.workflowId} · ${run.status}`,
        group: 'Run',
        icon: 'runs' as const,
        keywords: 'history result',
        run: () => {
          void store().openRunInRuns(run.id);
        },
      })),
    ];
  }, [workflows, runs, builtinTemplates, userTemplates, onOpenWizard]);

  const trimmed = query.trim();
  const matches = useMemo(() => {
    const found = commands.filter((c) => paletteMatches(c, trimmed));
    // With nothing typed, show places and actions, not every workflow twice.
    const shown = trimmed === '' ? found.filter((c) => c.group !== 'Template') : found;
    const draft: PaletteCommand[] =
      trimmed.length >= 8
        ? [
            {
              id: 'action-draft',
              label: `Draft a workflow: “${trimmed}”`,
              group: 'Generate',
              icon: 'sparkle',
              run: () => {
                useAppStore
                  .getState()
                  .setPendingIntent({ kind: 'generate', goal: trimmed });
                useAppStore.getState().setView('workflows');
              },
            },
          ]
        : [];
    return [...shown.slice(0, MAX_RESULTS), ...draft];
  }, [commands, trimmed]);
  const current = Math.min(active, Math.max(0, matches.length - 1));

  const choose = (command: PaletteCommand | undefined): void => {
    if (command === undefined) return;
    onClose();
    command.run();
  };

  return (
    <Modal
      label="Command palette"
      onClose={onClose}
      closeLabel="Close command palette"
      onBackdrop={onClose}
      maxWidth={640}
      className="palette"
    >
      <div className="palette-input-row">
        <Icon name="search" size={18} />
        <input
          className="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            matches[current] === undefined ? undefined : `${listId}-${String(current)}`
          }
          aria-label="Search views, workflows, templates and actions"
          placeholder="Search, or describe what you want done…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((current + 1) % Math.max(1, matches.length));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((current - 1 + matches.length) % Math.max(1, matches.length));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose(matches[current]);
            }
          }}
        />
      </div>
      <ul className="palette-list" id={listId} role="listbox" aria-label="Results">
        {matches.length === 0 && (
          <li className="palette-empty" role="presentation">
            Nothing found. Type a longer goal to draft a workflow from it.
          </li>
        )}
        {matches.map((command, index) => (
          <li
            key={command.id}
            id={`${listId}-${String(index)}`}
            role="option"
            aria-selected={index === current}
            className={`palette-item${index === current ? ' active' : ''}`}
            onMouseMove={() => {
              if (index !== current) setActive(index);
            }}
            onMouseDown={(e) => {
              // Keep focus in the input until the command runs.
              e.preventDefault();
            }}
            onClick={() => {
              choose(command);
            }}
          >
            <span className="palette-item-icon" aria-hidden="true">
              <Icon name={command.icon} size={16} />
            </span>
            <span className="palette-item-label">{command.label}</span>
            <span className="palette-item-group">{command.group}</span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
