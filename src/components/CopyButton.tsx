import { useEffect, useState } from 'react';

/**
 * Copies `text` to the clipboard and confirms for two seconds. Clipboard
 * refusals (no permission, insecure context) leave the label unchanged.
 */
export function CopyButton({
  text,
  label = 'Copy',
  className = 'btn',
  disabled,
}: {
  text: string;
  label?: string;
  className?: string;
  disabled?: boolean;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, 2000);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);
  return (
    <button
      type="button"
      className={className}
      disabled={disabled}
      onClick={() => {
        try {
          void navigator.clipboard
            .writeText(text)
            .then(() => {
              setCopied(true);
            })
            .catch(() => {
              setCopied(false);
            });
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? 'Copied ✓' : label}
    </button>
  );
}
