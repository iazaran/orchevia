import { expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __setMockBackendForTests } from '../lib/backend';
import { createDefaultProfile, type AgentProfile } from '../lib/agents';
import type { PermissionDenied } from '../lib/permissions';
import { useAppStore } from '../store';
import { ConfirmHost } from './ConfirmDialog';
import { PermissionDenials } from './PermissionDenials';

const denied: PermissionDenied = {
  profileId: 'prof',
  denials: [
    {
      toolName: 'mcp__jira__getIssue',
      toolUseId: 'toolu_1',
      rules: ['mcp__jira'],
    },
  ],
  rules: ['mcp__jira'],
};

function renderFor(profile: AgentProfile): void {
  localStorage.clear();
  __setMockBackendForTests();
  useAppStore.setState({ profiles: [profile] });
  render(
    <>
      <PermissionDenials denied={denied} />
      <ConfirmHost />
    </>,
  );
}

it('discloses saved rules that adding a refused tool reactivates', async () => {
  renderFor({
    ...createDefaultProfile('claude'),
    id: 'prof',
    name: 'Reader',
    allowedTools: ['Bash'],
  });
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Add 1 rule to Reader' }));
  const confirm = await screen.findByRole('alertdialog');
  expect(confirm).toHaveTextContent('Adds mcp__jira');
  expect(confirm).toHaveTextContent('Its saved list (Bash) applies again too.');
  expect(
    within(confirm).getByRole('button', { name: 'Add to allowed tools' }),
  ).toBeVisible();
});

it('sends a profile with its own permission arguments to manual editing', () => {
  renderFor({
    ...createDefaultProfile('claude'),
    id: 'prof',
    name: 'Legacy',
    extraArgs: ['--allowedTools', 'Read'],
  });
  expect(screen.queryByRole('button', { name: /Add 1 rule/ })).not.toBeInTheDocument();
  expect(
    screen.getByText(/Legacy sets permissions in its extra argument '--allowedTools'/),
  ).toBeInTheDocument();
});
