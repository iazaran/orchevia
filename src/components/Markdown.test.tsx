import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MarkdownText } from './Markdown';

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
