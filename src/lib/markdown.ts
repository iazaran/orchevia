/**
 * Minimal markdown renderer for agent outputs (no dependencies).
 * Supports what agents actually emit: headings, bold/italic, inline code,
 * fenced code blocks, bullet/numbered lists, rules, and paragraphs.
 * Everything is HTML-escaped first, so rendered output cannot inject markup.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** True when the text looks like formatted markdown rather than plain logs. */
export function isMarkdown(text: string): boolean {
  return (
    /^(#{1,4}\s|```|(\s*[-*] )|\d+\. )/m.test(text) ||
    /\*\*[^*\n]+\*\*/.test(text) ||
    /`[^`\n]+`/.test(text)
  );
}

function renderInline(s: string): string {
  const codeSpans: string[] = [];
  const withCode = escapeHtml(s).replace(/`([^`\n]+)`/g, (_, code: string) => {
    codeSpans.push(`<code>${code}</code>`);
    return `\uE000${String(codeSpans.length - 1)}\uE000`;
  });
  const rich = withCode
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return rich.replace(/\uE000(\d+)\uE000/g, (_, i: string) => codeSpans[Number(i)] ?? '');
}

/** Render markdown to an HTML string (sanitized by construction). */
export function renderMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  let list: 'ul' | 'ol' | null = null;
  const closeList = (): void => {
    if (list !== null) {
      out.push(list === 'ul' ? '</ul>' : '</ol>');
      list = null;
    }
  };
  const paragraph: string[] = [];
  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      out.push(`<p>${paragraph.map(renderInline).join('<br />')}</p>`);
      paragraph.length = 0;
    }
  };
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      flushParagraph();
      closeList();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      i += 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading !== null) {
      flushParagraph();
      closeList();
      const level = heading[1]?.length ?? 1;
      out.push(
        `<h${String(level)}>${renderInline(heading[2] ?? '')}</h${String(level)}>`,
      );
      i += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flushParagraph();
      closeList();
      out.push('<hr />');
      i += 1;
      continue;
    }
    const bullet = /^([-*])\s+(.*)$/.exec(trimmed);
    const ordered = /^(\d+)\.\s+(.*)$/.exec(trimmed);
    if (bullet !== null || ordered !== null) {
      flushParagraph();
      const kind = bullet !== null ? 'ul' : 'ol';
      if (list !== kind) {
        closeList();
        out.push(kind === 'ul' ? '<ul>' : '<ol>');
        list = kind;
      }
      out.push(`<li>${renderInline((bullet ?? ordered)?.[2] ?? '')}</li>`);
      i += 1;
      continue;
    }
    if (trimmed === '') {
      flushParagraph();
      closeList();
      i += 1;
      continue;
    }
    paragraph.push(line);
    i += 1;
  }
  flushParagraph();
  closeList();
  return out.join('\n');
}
