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
