import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { DirPicker } from './DirPicker';
import { KeyValueTextarea, LinesTextarea, parseKeyValueLines } from './DraftText';

function Lines({ initial = [] }: { initial?: string[] }): React.JSX.Element {
  const [lines, setLines] = useState(initial);
  return (
    <>
      <LinesTextarea aria-label="Arguments" value={lines} onChange={setLines} />
      <output>{JSON.stringify(lines)}</output>
      <button
        onClick={() => {
          setLines(['--replaced']);
        }}
      >
        Replace
      </button>
    </>
  );
}

describe('LinesTextarea', () => {
  it('lets Enter start the next argument instead of merging them', async () => {
    render(<Lines />);
    await userEvent.type(
      screen.getByLabelText('Arguments'),
      'mcp-atlassian{Enter}--read-only',
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      '["mcp-atlassian","--read-only"]',
    );
    expect(screen.getByLabelText('Arguments')).toHaveValue('mcp-atlassian\n--read-only');
  });

  it('keeps a space typed between words', async () => {
    render(<Lines />);
    await userEvent.type(screen.getByLabelText('Arguments'), 'hello world');
    expect(screen.getByRole('status')).toHaveTextContent('["hello world"]');
  });

  it('shows a value changed elsewhere', async () => {
    render(<Lines initial={['--a']} />);
    await userEvent.type(screen.getByLabelText('Arguments'), '{Enter}');
    await userEvent.click(screen.getByText('Replace'));
    expect(screen.getByLabelText('Arguments')).toHaveValue('--replaced');
  });
});

describe('KeyValueTextarea', () => {
  it('keeps a key that has no "=" yet while it is typed', async () => {
    function Pairs(): React.JSX.Element {
      const [pairs, setPairs] = useState<Record<string, string>>({});
      return (
        <>
          <KeyValueTextarea
            aria-label="MCP arguments"
            value={pairs}
            onChange={setPairs}
          />
          <output>{JSON.stringify(pairs)}</output>
        </>
      );
    }
    render(<Pairs />);
    await userEvent.type(
      screen.getByLabelText('MCP arguments'),
      'key=DEV-1{Enter}fields=summary',
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      '{"key":"DEV-1","fields":"summary"}',
    );
  });

  it('parses only lines with a key', () => {
    expect(parseKeyValueLines('key=a\nhalf\n=x\n b = c ')).toEqual({ key: 'a', b: 'c' });
  });
});

describe('DirPicker', () => {
  it('keeps the space in a folder name while the stored path stays trimmed', async () => {
    function Folder(): React.JSX.Element {
      const [dir, setDir] = useState('');
      return (
        <>
          <DirPicker
            id="dir"
            label="Folder"
            value={dir}
            onChange={(v) => {
              setDir(v.trim());
            }}
          />
          <output>{JSON.stringify(dir)}</output>
        </>
      );
    }
    render(<Folder />);
    await userEvent.type(screen.getByLabelText('Folder'), '/Users/x/My Repo');
    expect(screen.getByRole('status')).toHaveTextContent('"/Users/x/My Repo"');
  });
});
