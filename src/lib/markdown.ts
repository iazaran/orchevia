/** Safe Markdown for local CLI reports. Raw HTML is always rendered as text. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function emphasis(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
}

function renderLinks(s: string): string {
  const pattern = /\[([^\]\n]+)\]\(([^\s)]+)\)/g;
  let rendered = '';
  let end = 0;
  for (const match of s.matchAll(pattern)) {
    const index = match.index;
    rendered += emphasis(s.slice(end, index));
    const url = match[2] ?? '';
    const safe =
      /^(https?:\/\/|mailto:|#)/i.test(url) &&
      !Array.from(url).some((ch) => ch.charCodeAt(0) <= 32 || ch.charCodeAt(0) === 127);
    rendered += safe
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${emphasis(match[1] ?? '')}</a>`
      : emphasis(match[0]);
    end = index + match[0].length;
  }
  return rendered + emphasis(s.slice(end));
}

function renderInline(s: string): string {
  // Parse code first so its contents never become links or emphasis.
  const pattern = /`([^`\n]+)`/g;
  let rendered = '';
  let end = 0;
  for (const match of s.matchAll(pattern)) {
    rendered += renderLinks(s.slice(end, match.index));
    rendered += `<code>${escapeHtml(match[1] ?? '')}</code>`;
    end = match.index + match[0].length;
  }
  return rendered + renderLinks(s.slice(end));
}

/** Split table cells, respecting escaped pipes and pipes in inline code. */
function cells(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const result: string[] = [];
  let cell = '';
  let code = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (ch === '\\' && text[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (ch === '`') {
      code = !code;
      cell += ch;
    } else if (ch === '|' && !code) {
      result.push(cell.trim());
      cell = '';
    } else cell += ch;
  }
  result.push(cell.trim());
  return result;
}

function tableAlignments(line: string): ('left' | 'right' | 'center' | null)[] | null {
  if (!line.includes('|')) return null;
  const columns = cells(line);
  if (!columns.length || columns.some((c) => !/^:?-{3,}:?$/.test(c))) return null;
  return columns.map((c) =>
    c.startsWith(':') && c.endsWith(':')
      ? 'center'
      : c.endsWith(':')
        ? 'right'
        : c.startsWith(':')
          ? 'left'
          : null,
  );
}

export function isMarkdown(text: string): boolean {
  return (
    /^(#{1,6}\s|```|~~~|(\s*[-*+] )|\d+[.)] )/m.test(text) ||
    /\*\*[^*\n]+\*\*/.test(text) ||
    /`[^`\n]+`/.test(text) ||
    /\[[^\]\n]+\]\([^\s)]+\)/.test(text) ||
    text.split(/\r?\n/).some((line) => tableAlignments(line) !== null)
  );
}

function listItem(line: string): RegExpExecArray | null {
  return /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
}

function renderList(lines: string[], start: number): { html: string; next: number } {
  const first = listItem(lines[start] ?? '');
  if (!first) return { html: '', next: start + 1 };
  const indent = first[1]?.length ?? 0;
  const ordered = /^\d/.test(first[2] ?? '');
  const number = Number.parseInt(first[2] ?? '1', 10);
  const tag = ordered ? 'ol' : 'ul';
  const items: string[] = [];
  let i = start;
  while (i < lines.length) {
    const item = listItem(lines[i] ?? '');
    if (
      !item ||
      (item[1]?.length ?? 0) !== indent ||
      /^\d/.test(item[2] ?? '') !== ordered
    )
      break;
    const body = [item[3] ?? ''];
    const contentIndent = item[0].length - (item[3]?.length ?? 0);
    i++;
    while (i < lines.length) {
      const line = lines[i] ?? '';
      if (!line.trim()) {
        let next = i + 1;
        while (next < lines.length && !(lines[next] ?? '').trim()) next++;
        const following = lines[next] ?? '';
        const nextItem = listItem(following);
        if (nextItem && (nextItem[1]?.length ?? 0) === indent) {
          i = next;
          break;
        }
        if ((/^\s*/.exec(following)?.[0].length ?? 0) <= indent) {
          i = next;
          break;
        }
        body.push('');
        i++;
        continue;
      }
      const depth = /^\s*/.exec(line)?.[0].length ?? 0;
      if (depth <= indent) break;
      body.push(line.slice(Math.min(contentIndent, depth)));
      i++;
    }
    const content = renderMarkdown(body.join('\n'));
    const simple = /^<p>([^]*?)<\/p>$/.exec(content);
    items.push(
      `<li>${simple && !content.includes('</p>\n') ? (simple[1] ?? '') : content}</li>`,
    );
  }
  const opening = ordered && number !== 1 ? `<ol start="${String(number)}">` : `<${tag}>`;
  return { html: `${opening}\n${items.join('\n')}\n</${tag}>`, next: i };
}

/** Render to HTML with all user text escaped, including attributes. */
export function renderMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  const paragraph: string[] = [];
  const flushParagraph = (): void => {
    if (paragraph.length) {
      out.push(`<p>${paragraph.map(renderInline).join('<br />')}</p>`);
      paragraph.length = 0;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    const fence = /^(\x60{3,}|~{3,})/.exec(trimmed)?.[1];
    if (fence) {
      flushParagraph();
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(fence)) {
        body.push(lines[i] ?? '');
        i++;
      }
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      i++;
      continue;
    }
    const alignments = tableAlignments(lines[i + 1] ?? '');
    if (line.includes('|') && alignments && cells(line).length === alignments.length) {
      flushParagraph();
      const cellHtml = (value: string, column: number, tag: 'td' | 'th'): string => {
        const align = alignments[column];
        return `<${tag}${align ? ` style="text-align:${align}"` : ''}>${renderInline(value)}</${tag}>`;
      };
      const header = cells(line)
        .map((c, n) => cellHtml(c, n, 'th'))
        .join('');
      const rows: string[] = [];
      i += 2;
      while (
        i < lines.length &&
        (lines[i] ?? '').includes('|') &&
        (lines[i] ?? '').trim()
      ) {
        const row = cells(lines[i] ?? '');
        rows.push(
          `<tr>${alignments.map((_, n) => cellHtml(row[n] ?? '', n, 'td')).join('')}</tr>`,
        );
        i++;
      }
      out.push(
        `<div class="md-table-scroll"><table><thead><tr>${header}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      const level = String(heading[1]?.length ?? 1);
      out.push(`<h${level}>${renderInline(heading[2] ?? '')}</h${level}>`);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      out.push('<hr />');
      i++;
      continue;
    }
    if (listItem(line)) {
      flushParagraph();
      const list = renderList(lines, i);
      out.push(list.html);
      i = list.next;
      continue;
    }
    if (!trimmed) flushParagraph();
    else paragraph.push(line);
    i++;
  }
  flushParagraph();
  return out.join('\n');
}
