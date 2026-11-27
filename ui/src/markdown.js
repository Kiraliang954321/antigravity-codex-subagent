export function escapeHtml(raw) {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatInline(escapedText) {
  const codeSpans = [];
  let text = escapedText.replace(/`([^`\n]+)`/g, (_match, code) => {
    const token = `\u0000CODE${codeSpans.length}\u0000`;
    codeSpans.push(`<code class="inline-code">${code}</code>`);
    return token;
  });

  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
    const cleanUrl = url.replace(/&amp;/g, '&');
    if (!/^https?:\/\//i.test(cleanUrl)) return label;
    return `<a class="md-link" href="${escapeHtml(cleanUrl)}" data-ext-link="${escapeHtml(cleanUrl)}" rel="noopener noreferrer">${label}</a>`;
  });

  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  return text.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx) => codeSpans[Number(idx)] ?? '');
}

function renderParagraphLines(lines) {
  const escaped = lines.map((line) => formatInline(escapeHtml(line)));
  return `<p>${escaped.join('<br />')}</p>`;
}

export function renderMarkdown(source, copyLabel = 'Copy') {
  const input = String(source ?? '').replace(/\r\n?/g, '\n').trim();
  if (!input) return '';

  const lines = input.split('\n');
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fenceMatch = /^```([^\n`]*)$/.exec(line.trim());
    if (fenceMatch) {
      const lang = fenceMatch[1].trim();
      const body = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      html.push(
        `<div class="code-wrap"><div class="code-head"><span class="code-lang">${escapeHtml(lang || 'text')}</span><button type="button" class="mini-btn copy-code-btn">${escapeHtml(copyLabel)}</button></div><pre class="code-pre"><code>${escapeHtml(body.join('\n'))}</code></pre></div>`,
      );
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      html.push(`<h${level} class="md-h">${formatInline(escapeHtml(headingMatch[2]))}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      html.push(`<blockquote class="md-quote">${renderParagraphLines(quoteLines)}</blockquote>`);
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(`<li>${formatInline(escapeHtml(lines[i].replace(/^[-*]\s+/, '')))}</li>`);
        i += 1;
      }
      html.push(`<ul class="md-list">${items.join('')}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${formatInline(escapeHtml(lines[i].replace(/^\d+\.\s+/, '')))}</li>`);
        i += 1;
      }
      html.push(`<ol class="md-list">${items.join('')}</ol>`);
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      html.push('<hr class="md-hr" />');
      i += 1;
      continue;
    }

    const paraLines = [];
    while (
      i < lines.length
      && lines[i].trim() !== ''
      && !/^```/.test(lines[i].trim())
      && !/^(#{1,4})\s+/.test(lines[i])
      && !/^>\s?/.test(lines[i])
      && !/^[-*]\s+/.test(lines[i])
      && !/^\d+\.\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    html.push(renderParagraphLines(paraLines));
  }

  return `<div class="md-body">${html.join('')}</div>`;
}

export function renderDiff(diffText) {
  const lines = String(diffText ?? '').replace(/\r\n?/g, '\n').split('\n');
  const rendered = lines.map((line) => {
    const escaped = escapeHtml(line) || ' ';
    if (line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      return `<div class="diff-line diff-meta">${escaped}</div>`;
    }
    if (line.startsWith('@@')) {
      return `<div class="diff-line diff-hunk">${escaped}</div>`;
    }
    if (line.startsWith('+')) {
      return `<div class="diff-line diff-add">${escaped}</div>`;
    }
    if (line.startsWith('-')) {
      return `<div class="diff-line diff-del">${escaped}</div>`;
    }
    return `<div class="diff-line">${escaped}</div>`;
  });
  return `<div class="diff-view">${rendered.join('')}</div>`;
}
