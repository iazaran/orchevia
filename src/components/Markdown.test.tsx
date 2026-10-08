import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MarkdownText } from './Markdown';
import { isMarkdown, renderMarkdown } from '../lib/markdown';

// Count parser calls while keeping the real implementations.
vi.mock('../lib/markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/markdown')>();
  return {
    ...actual,
    isMarkdown: vi.fn(actual.isMarkdown),
    renderMarkdown: vi.fn(actual.renderMarkdown),
  };
});

beforeEach(() => {
  vi.mocked(isMarkdown).mockClear();
  vi.mocked(renderMarkdown).mockClear();
});

it('renders report tables, links and numbering and preserves exact raw output', async () => {
  const text =
    '# Review\n\n| PR | Result |\n| --- | --- |\n| [42](https://example.com/pr/42) | `ok` |\n\n1. First\n\n1. Second\n\n<script>alert(1)</script>';
  const { container } = render(<MarkdownText text={text} />);
  expect(screen.getByRole('heading', { name: 'Review' })).toBeInTheDocument();
  expect(screen.getByRole('table')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '42' })).toHaveAttribute(
    'href',
    'https://example.com/pr/42',
  );
  expect(container.querySelectorAll('ol')).toHaveLength(1);
  expect(container.querySelector('script')).toBeNull();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Show raw text' }));
  expect(container.querySelector('.log-block')?.textContent).toBe(text);
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Show formatted text' }));
  expect(screen.getByRole('table')).toBeInTheDocument();
});

it('parses unchanged text once across rerenders and Raw/Formatted toggles', async () => {
  const text =
    '# Report\n\n- [safe](https://example.com)\n- [unsafe](javascript:alert(1))';
  const view = render(<MarkdownText text={text} />);
  for (let i = 0; i < 5; i++) view.rerender(<MarkdownText text={text} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Show raw text' }));
  expect(view.container.querySelector('.log-block')?.textContent).toBe(text);
  await user.click(screen.getByRole('button', { name: 'Show formatted text' }));
  expect(vi.mocked(renderMarkdown)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(isMarkdown)).toHaveBeenCalledTimes(1);
  // Formatting and link safety are unchanged by memoization.
  expect(screen.getByRole('link', { name: 'safe' })).toHaveAttribute(
    'href',
    'https://example.com',
  );
  expect(screen.queryByRole('link', { name: 'unsafe' })).toBeNull();
  expect(view.container.textContent).toContain('[unsafe](javascript:alert(1))');
});

it('updates when the text changes and keeps collapsed previews without a raw toggle', () => {
  const view = render(<MarkdownText text={'# First'} />);
  expect(screen.getByRole('heading', { name: 'First' })).toBeInTheDocument();
  view.rerender(<MarkdownText text={'# Second <b>x</b>'} />);
  expect(screen.getByRole('heading', { name: /Second/ })).toBeInTheDocument();
  expect(view.container.querySelector('b')).toBeNull();
  expect(vi.mocked(renderMarkdown)).toHaveBeenCalledTimes(2);
  view.rerender(<MarkdownText text={'# Preview\n\n- item\n…'} allowRaw={false} />);
  expect(screen.queryByRole('button', { name: 'Show raw text' })).toBeNull();
  // Plain logs stay preformatted text, unparsed.
  view.rerender(<MarkdownText text={'plain log line'} />);
  expect(view.container.querySelector('.log-block')?.textContent).toBe('plain log line');
  expect(vi.mocked(renderMarkdown)).toHaveBeenCalledTimes(3);
});
