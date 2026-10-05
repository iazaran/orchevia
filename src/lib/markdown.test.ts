import { describe, expect, it } from 'vitest';
import { isMarkdown, renderMarkdown } from './markdown';

describe('markdown renderer', () => {
  it('detects formatted text and ignores plain logs', () => {
    expect(isMarkdown('## Answer\nSome **bold** text')).toBe(true);
    expect(isMarkdown('`code` and more')).toBe(true);
    expect(isMarkdown('- item one\n- item two')).toBe(true);
    expect(isMarkdown('plain log line\nanother line')).toBe(false);
    expect(isMarkdown('a * b = c')).toBe(false);
  });

  it('renders headings, bold, italic, and code', () => {
    const html = renderMarkdown('## Answer\nThis is **bold** and *italic* with `code`.');
    expect(html).toContain('<h2>Answer</h2>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>code</code>');
  });

  it('renders lists and fences', () => {
    const html = renderMarkdown('- a\n- b\n\n```\ncode()\n```');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('<pre><code>code()</code></pre>');
  });

  it('escapes injected markup', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n**x**');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<strong>x</strong>');
  });

  it('does not treat math as emphasis', () => {
    expect(renderMarkdown('a * b = c')).toContain('a * b = c');
  });
});

it('detects and renders pipe tables with alignment, escapes and code pipes', () => {
  const text = '| Step | Result |\n| :--- | ---: |\n| `a|b` | **ok** \\| done |';
  expect(isMarkdown(text)).toBe(true);
  const html = renderMarkdown(text);
  expect(html).toContain('<table>');
  expect(html).toContain('<th style="text-align:left">Step</th>');
  expect(html).toContain('<td style="text-align:right"><strong>ok</strong> | done</td>');
  expect(html).toContain('<code>a|b</code>');
  expect(renderMarkdown('a | b\n--- | ---\n<script> | x')).toContain('&lt;script&gt;');
});

it('keeps repeated one numbering in one ordered list across blank lines and nests lists', () => {
  const html = renderMarkdown(
    '3. First\n\n1. Second\n   - Child\n     - Grandchild\n\n1. Third\n\nAfter',
  );
  expect(html.match(/<ol/g)).toHaveLength(1);
  expect(html).toContain('<ol start="3">');
  expect(html.match(/<ul>/g)).toHaveLength(2);
  expect(html.indexOf('</ol>')).toBeLessThan(html.indexOf('<p>After</p>'));
});

it('renders safe links while refusing script/data URLs and preserving code literally', () => {
  const html = renderMarkdown(
    '[PR](https://example.com/pr?a=1&b=2) and [bad](javascript:alert) and [bad](data:text/html)\n\n`[literal](https://example.com)`',
  );
  expect(html).toContain('href="https://example.com/pr?a=1&amp;b=2"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain('href="data:');
  expect(html).toContain('<code>[literal](https://example.com)</code>');
  expect(renderMarkdown('[**bold**](https://example.com/"onclick="x)')).not.toContain(
    ' onclick=',
  );
});

it('renders six heading levels, multiline list bodies and adjacent paragraphs safely', () => {
  const html = renderMarkdown(
    '###### Fine print\n- first\n  continued **bold**\n\n  another paragraph\n- second\n\nEnd\n\n```html\n<img src=x onerror=alert(1)>\n```',
  );
  expect(html).toContain('<h6>Fine print</h6>');
  expect(html).toContain('<strong>bold</strong>');
  expect(html).toContain('<p>another paragraph</p>');
  expect(html).toContain('</ul>\n<p>End</p>');
  expect(html).not.toContain('<img');
});
