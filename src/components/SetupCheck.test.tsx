import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __setMockBackendForTests } from '../lib/backend';
import { createDefaultProfile, type SetupCheckReport } from '../lib/agents';
import { SetupCheckPanel } from './SetupCheck';

function report(id: string, status: SetupCheckReport['status']): SetupCheckReport {
  return {
    profileId: id,
    profileName: id,
    status,
    durationMs: 1,
    items: [{ id: 'installed', label: 'CLI installed', status, detail: `${id} detail` }],
  };
}

describe('SetupCheckPanel', () => {
  it('checks profiles one at a time and opens only those that need attention', async () => {
    const backend = __setMockBackendForTests();
    const order: string[] = [];
    let inFlight = 0;
    backend.checkAgentSetup = async (id) => {
      inFlight += 1;
      expect(inFlight).toBe(1);
      order.push(id);
      await Promise.resolve();
      inFlight -= 1;
      if (id === 'broken') throw new Error('Unknown Agent Profile');
      return report(id, id === 'ok' ? 'passed' : 'failed');
    };
    const profiles = ['ok', 'bad', 'broken'].map((id) => ({
      ...createDefaultProfile('claude'),
      id,
      name: id,
    }));
    const user = userEvent.setup();
    render(<SetupCheckPanel profiles={profiles} />);

    expect(order).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Check every profile' }));
    await screen.findByText('Check failed');
    expect(order).toEqual(['ok', 'bad', 'broken']);
    const rows = screen
      .getAllByRole('listitem')
      .filter((li) => li.querySelector('details'));
    expect(rows).toHaveLength(3);
    const [ok, bad] = rows;
    expect(within(ok!).getByText('Ready')).toBeInTheDocument();
    expect(ok!.querySelector('details')?.open).toBe(false);
    expect(within(bad!).getByText('Needs attention')).toBeInTheDocument();
    expect(bad!.querySelector('details')?.open).toBe(true);
    expect(screen.getByRole('button', { name: 'Check every profile' })).toBeEnabled();
  });

  it('points to Agents when there is nothing to check', () => {
    __setMockBackendForTests();
    render(<SetupCheckPanel profiles={[]} />);
    expect(screen.getByText(/Add an Agent Profile in Agents/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
