/**
 * Line icons drawn for Orchevia on a 24 × 24 grid. They inherit the text
 * colour and are hidden from screen readers: the control around them names
 * the action.
 */
export type IconName =
  | 'workflows'
  | 'agents'
  | 'templates'
  | 'automations'
  | 'playbooks'
  | 'runs'
  | 'environment'
  | 'usage'
  | 'inbox'
  | 'plus'
  | 'sparkle'
  | 'play'
  | 'flask'
  | 'code'
  | 'transfer'
  | 'bookmark'
  | 'gauge'
  | 'trash'
  | 'plug'
  | 'check'
  | 'search';

const PATHS: Record<IconName, React.JSX.Element> = {
  workflows: (
    <>
      <rect x="3" y="3" width="7" height="6" rx="1.6" />
      <rect x="14" y="15" width="7" height="6" rx="1.6" />
      <path d="M6.5 9v3.5a2 2 0 0 0 2 2H14" />
      <path d="M17.5 15v-3" />
      <circle cx="17.5" cy="8" r="2.2" />
    </>
  ),
  agents: (
    <>
      <path d="M11 3.5l1.7 4.6 4.6 1.7-4.6 1.7L11 16.1l-1.7-4.6-4.6-1.7 4.6-1.7z" />
      <path d="M18.5 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
    </>
  ),
  templates: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
      <path d="M17 14v6M14 17h6" />
    </>
  ),
  automations: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  playbooks: (
    <>
      <path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v14H7.5A2.5 2.5 0 0 0 5 19.5z" />
      <path d="M5 19.5A2.5 2.5 0 0 0 7.5 22H19v-5" />
      <path d="M9 7.5h6M9 11h4" />
    </>
  ),
  runs: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M10.2 8.6v6.8l5.6-3.4z" />
    </>
  ),
  environment: (
    <>
      <rect x="3.5" y="4" width="17" height="6.5" rx="1.8" />
      <rect x="3.5" y="13.5" width="17" height="6.5" rx="1.8" />
      <path d="M7.5 7.25h.01M7.5 16.75h.01M11 7.25h5M11 16.75h5" />
    </>
  ),
  usage: (
    <>
      <path d="M4 20h16" />
      <path d="M7 16.5v-4M12 16.5V7M17 16.5v-7" />
    </>
  ),
  inbox: (
    <>
      <path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 1.5h-15z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  sparkle: (
    <>
      <path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1-5.1-1.9 5.1-1.9z" />
      <path d="M19 16.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" />
    </>
  ),
  play: <path d="M8 5.5v13l10.5-6.5z" />,
  flask: (
    <>
      <path d="M9.5 3.5h5M10.5 3.5v5.2L5.3 18a1.7 1.7 0 0 0 1.5 2.5h10.4a1.7 1.7 0 0 0 1.5-2.5l-5.2-9.3V3.5" />
      <path d="M7.5 14.5h9" />
    </>
  ),
  code: <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" />,
  transfer: (
    <>
      <path d="M7 4.5v13M3.5 14l3.5 3.5 3.5-3.5" />
      <path d="M17 19.5v-13M13.5 10L17 6.5l3.5 3.5" />
    </>
  ),
  bookmark: <path d="M7 3.5h10a1 1 0 0 1 1 1V20l-6-3.8L6 20V4.5a1 1 0 0 1 1-1z" />,
  gauge: (
    <>
      <path d="M4 16a8 8 0 1 1 16 0" />
      <path d="M12 16l3.5-4.5" />
      <path d="M4 19.5h16" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15M9.5 7V4.5h5V7" />
      <path d="M6.5 7l.9 12.2a1.5 1.5 0 0 0 1.5 1.3h6.2a1.5 1.5 0 0 0 1.5-1.3L17.5 7" />
    </>
  ),
  plug: (
    <>
      <path d="M9 3.5v4M15 3.5v4" />
      <path d="M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0z" />
      <path d="M12 16v4.5" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
};

export function Icon({
  name,
  size = 18,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}): React.JSX.Element {
  return (
    <svg
      className={`icon${className === undefined ? '' : ` ${className}`}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/** The Orchevia mark: an orchestration ring with three connected agents. */
export function BrandMark(): React.JSX.Element {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="brand-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2f6fed" />
          <stop offset="0.55" stopColor="#6d64f6" />
          <stop offset="1" stopColor="#a855f7" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="62" height="62" rx="15" fill="url(#brand-bg)" />
      <circle
        cx="32"
        cy="32"
        r="18.5"
        fill="none"
        stroke="#fff"
        strokeOpacity="0.85"
        strokeWidth="3.4"
      />
      <circle cx="32" cy="32" r="6.5" fill="#fff" />
      <circle cx="32" cy="13.5" r="5.2" fill="#34d399" stroke="#fff" strokeWidth="1.8" />
      <circle cx="16" cy="41.5" r="5.2" fill="#6ea8fe" stroke="#fff" strokeWidth="1.8" />
      <circle cx="48" cy="41.5" r="5.2" fill="#f472b6" stroke="#fff" strokeWidth="1.8" />
    </svg>
  );
}
