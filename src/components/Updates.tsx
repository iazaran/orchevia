import { useEffect, useState } from 'react';
import { getBackend } from '../lib/backend';
import { errorMessage } from '../lib/errors';
import { formatTime } from '../lib/time';
import {
  RELEASES_URL,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_SETTING,
  UPDATE_DISMISSED_SETTING,
  UPDATE_FIRST_CHECK_DELAY_MS,
  assetFor,
  installSteps,
  type DesktopInfo,
} from '../lib/updates';
import { useAppStore } from '../store';
import { Notice, useNoticeMessage } from './Notice';
import { Switch } from './Switch';
import { version } from '../../package.json';

/** Automatic update checks: shortly after launch, then twice a day, unless off. */
export function useAutomaticUpdateChecks(): void {
  useEffect(() => {
    let alive = true;
    const run = async (): Promise<void> => {
      try {
        const setting = await getBackend().getSetting(UPDATE_CHECK_SETTING);
        if (!alive || setting === '0') return;
      } catch {
        return;
      }
      await useAppStore.getState().checkForUpdates(true);
    };
    const first = setTimeout(() => {
      void run();
    }, UPDATE_FIRST_CHECK_DELAY_MS);
    const repeat = setInterval(() => {
      void run();
    }, UPDATE_CHECK_INTERVAL_MS);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(repeat);
    };
  }, []);
}

function useDesktopInfo(): DesktopInfo | null {
  const [desktop, setDesktop] = useState<DesktopInfo | null>(null);
  useEffect(() => {
    let alive = true;
    void getBackend()
      .desktopInfo()
      .then((info) => {
        if (alive) setDesktop(info);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return desktop;
}

/** App-wide banner while a newer release is available and not hidden. */
export function UpdateBanner(): React.JSX.Element | null {
  const check = useAppStore((s) => s.updateCheck);
  const setView = useAppStore((s) => s.setView);
  // undefined: still loading the hidden version, so nothing flashes.
  const [hidden, setHidden] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void getBackend()
      .getSetting(UPDATE_DISMISSED_SETTING)
      .then((value) => {
        if (alive) setHidden(value);
      })
      .catch(() => {
        if (alive) setHidden(null);
      });
    return () => {
      alive = false;
    };
  }, []);
  if (check === null || !check.updateAvailable || hidden === undefined) return null;
  const latest = check.latest.version;
  if (hidden === latest) return null;
  return (
    <Notice
      inline
      variant="info"
      className="update-banner"
      dismissLabel="Hide this update notice"
      onDismiss={() => {
        setHidden(latest);
        void getBackend()
          .setSetting(UPDATE_DISMISSED_SETTING, latest)
          .catch(() => {});
      }}
    >
      <span>
        <strong>Orchevia {latest} is ready.</strong> You have {check.current}; your
        workflows and history are kept when you update.
      </span>{' '}
      <button
        className="btn btn-ghost"
        onClick={() => {
          setView('environment');
        }}
      >
        How to update
      </button>
    </Notice>
  );
}

/** Environment → Updates: version, automatic checks, download and steps. */
export function UpdatesSection(): React.JSX.Element {
  const check = useAppStore((s) => s.updateCheck);
  const checking = useAppStore((s) => s.updateChecking);
  const error = useAppStore((s) => s.updateError);
  const checkForUpdates = useAppStore((s) => s.checkForUpdates);
  const desktop = useDesktopInfo();
  const [auto, setAuto] = useState<boolean | null>(null);
  const [message, setMessage, messageVariant, messageEvent] = useNoticeMessage();
  useEffect(() => {
    let alive = true;
    void getBackend()
      .getSetting(UPDATE_CHECK_SETTING)
      .then((value) => {
        if (alive) setAuto(value !== '0');
      })
      .catch(() => {
        if (alive) setAuto(true);
      });
    return () => {
      alive = false;
    };
  }, []);
  const setAutomatic = (on: boolean): void => {
    setAuto(on);
    void getBackend()
      .setSetting(UPDATE_CHECK_SETTING, on ? '1' : '0')
      .catch((err: unknown) => {
        setAuto(!on);
        setMessage(errorMessage(err), 'error');
      });
  };
  const open = (url: string): void => {
    void getBackend()
      .openExternalUrl(url)
      .catch((err: unknown) => {
        setMessage(errorMessage(err), 'error');
      });
  };
  const available = check?.updateAvailable === true ? check.latest : null;
  const asset = available === null ? undefined : assetFor(available, desktop);
  return (
    <section aria-label="Updates" className="tool-card" style={{ maxWidth: 680 }}>
      {message !== null && (
        <Notice
          variant={messageVariant}
          eventId={messageEvent}
          onDismiss={() => {
            setMessage(null);
          }}
        >
          {message}
        </Notice>
      )}
      <div className="background-card-head">
        <h3 style={{ margin: 0 }}>Orchevia {version}</h3>
        <Switch
          checked={auto === true}
          onChange={setAutomatic}
          label="Check for updates automatically"
          onText="Automatic checks on"
          offText="Automatic checks off"
          disabled={auto === null}
        />
      </div>
      <p className="field-hint" style={{ margin: '8px 0 0' }}>
        Orchevia asks GitHub for its latest release shortly after it starts and twice a
        day. The request carries nothing about you or your work, and nothing installs
        without you.
      </p>
      <p className="field-hint" role="status" style={{ margin: '8px 0 0' }}>
        {checking
          ? 'Checking…'
          : error !== null
            ? `Could not check: ${error}`
            : check === null
              ? 'Not checked yet.'
              : available !== null
                ? `Orchevia ${available.version} is available (checked ${formatTime(check.checkedAt)}).`
                : `You have the latest version (checked ${formatTime(check.checkedAt)}).`}
      </p>
      {available !== null && (
        <p className="field-hint" style={{ margin: '8px 0 0' }}>
          {installSteps(desktop, asset?.name)}
        </p>
      )}
      <div className="background-card-actions">
        <button
          className="btn"
          disabled={checking}
          onClick={() => {
            void checkForUpdates(true);
          }}
        >
          Check now
        </button>
        {asset !== undefined && (
          <button
            className="btn btn-primary"
            onClick={() => {
              open(asset.url);
            }}
          >
            Download {asset.name}
          </button>
        )}
        <button
          className="btn btn-ghost"
          onClick={() => {
            open(available?.url ?? RELEASES_URL);
          }}
        >
          {available !== null ? "What's new" : 'All releases'}
        </button>
      </div>
    </section>
  );
}
