import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { __setMockBackendForTests, type Backend } from '../lib/backend';
import { BranchPicker } from './BranchPicker';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function Harness({
  onBranch,
}: {
  onBranch?: (value: string) => void;
}): React.JSX.Element {
  const [dir, setDir] = useState('');
  const [branch, setBranch] = useState('');
  return (
    <>
      <input
        aria-label="Repository"
        value={dir}
        onChange={(e) => {
          setDir(e.target.value);
        }}
      />
      <BranchPicker
        id="branch"
        label="Branch"
        repoDir={dir}
        value={branch}
        onChange={(value) => {
          setBranch(value);
          onBranch?.(value);
        }}
      />
    </>
  );
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function suggestions(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('datalist option')).map(
    (option) => option.getAttribute('value') ?? '',
  );
}

it('queries branches once after repository path typing pauses', async () => {
  vi.useFakeTimers();
  const backend = __setMockBackendForTests();
  const branches = vi
    .spyOn(backend, 'gitBranches')
    .mockResolvedValue({ current: 'main', branches: ['main', 'feature/x'] });
  const branchValues: string[] = [];
  const view = render(<Harness onBranch={(value) => branchValues.push(value)} />);
  const repo = view.getByLabelText('Repository');
  const path = '/repo/path';
  for (let i = 1; i <= path.length; i++) {
    fireEvent.change(repo, { target: { value: path.slice(0, i) } });
    await advance(40);
  }
  expect(branches).not.toHaveBeenCalled();
  await advance(250);
  expect(branches).toHaveBeenCalledTimes(1);
  expect(branches).toHaveBeenCalledWith('/repo/path');
  expect(suggestions(view.container)).toEqual(['main', 'feature/x']);
  // Branch edits update immediately, allow new names and never query again.
  const input = view.getByLabelText('Branch');
  fireEvent.change(input, { target: { value: 'brand-new/branch' } });
  expect(input).toHaveValue('brand-new/branch');
  expect(branchValues).toEqual(['brand-new/branch']);
  await advance(1000);
  expect(branches).toHaveBeenCalledTimes(1);
});

it('never queries an empty path and drops suggestions that belong to another repo', async () => {
  vi.useFakeTimers();
  const backend = __setMockBackendForTests();
  const pending = new Map<
    string,
    (value: { current: string; branches: string[] }) => void
  >();
  const branches = vi.spyOn(backend as Backend, 'gitBranches').mockImplementation(
    (dir: string) =>
      new Promise<{ current: string; branches: string[] }>((resolve) => {
        pending.set(dir, resolve);
      }),
  );
  const view = render(<Harness />);
  const repo = view.getByLabelText('Repository');
  fireEvent.change(repo, { target: { value: '   ' } });
  await advance(500);
  expect(branches).not.toHaveBeenCalled();
  fireEvent.change(repo, { target: { value: '/repo/a' } });
  await advance(250);
  fireEvent.change(repo, { target: { value: '/repo/b' } });
  await advance(250);
  expect(branches.mock.calls.map(([dir]) => dir)).toEqual(['/repo/a', '/repo/b']);
  await act(async () => {
    pending.get('/repo/b')?.({ current: 'main', branches: ['b-branch'] });
    pending.get('/repo/a')?.({ current: 'main', branches: ['a-branch'] });
    await Promise.resolve();
  });
  expect(suggestions(view.container)).toEqual(['b-branch']);
  fireEvent.change(repo, { target: { value: '' } });
  await advance(500);
  expect(suggestions(view.container)).toEqual([]);
  expect(branches).toHaveBeenCalledTimes(2);
});

it('shows no suggestions after a failure and never queries after unmount', async () => {
  vi.useFakeTimers();
  const backend = __setMockBackendForTests();
  const branches = vi
    .spyOn(backend, 'gitBranches')
    .mockRejectedValue(new Error('Not a git repository.'));
  const view = render(<Harness />);
  const repo = view.getByLabelText('Repository');
  fireEvent.change(repo, { target: { value: '/not/a/repo' } });
  await advance(250);
  expect(branches).toHaveBeenCalledTimes(1);
  expect(suggestions(view.container)).toEqual([]);
  fireEvent.change(repo, { target: { value: '/other/repo' } });
  view.unmount();
  await advance(1000);
  expect(branches).toHaveBeenCalledTimes(1);
});
