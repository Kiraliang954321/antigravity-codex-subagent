export function escapeHtml(raw) {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function stripCodexFooter(raw) {
  const input = String(raw ?? '').replace(/\r\n?/g, '\n');
  const match = /(?:^|\n{1,2})\[codex-thread [^\n\]]+\]((?:\n+\[CONTEXT_WARNING\][^\n]*)*)\s*$/.exec(input);
  if (!match) return { body: input.trimEnd(), contextWarning: null };
  const body = input.slice(0, match.index).trimEnd();
  const warningBlock = match[1]?.trim() || null;
  const contextWarning = warningBlock
    ? warningBlock.replace(/^\[CONTEXT_WARNING\]\s*/gm, '').trim()
    : null;
  return { body, contextWarning };
}

export function lookupFileUri(rawPath, fileLinksByPath) {
  if (!fileLinksByPath || typeof fileLinksByPath.get !== 'function' || !rawPath) return null;
  const normalizedSlash = rawPath.replaceAll('\\', '/');
  const winNormalized = normalizedSlash.replace(/^\/(?=[A-Za-z]:\/)/, '');
  const candidates = [rawPath, normalizedSlash, winNormalized];
  for (const key of candidates) {
    if (fileLinksByPath.has(key)) return fileLinksByPath.get(key);
  }
  const lowerTarget = winNormalized.toLowerCase();
  for (const [key, uri] of fileLinksByPath.entries()) {
    if (key.replaceAll('\\', '/').replace(/^\/(?=[A-Za-z]:\/)/, '').toLowerCase() === lowerTarget) {
      return uri;
    }
  }
  return null;
}

function renderLocalFileRef(labelHtml, rawTarget, fileLinksByPath) {
  const match = /^(.*?)(:(\d+)(?::(\d+))?)$/.exec(rawTarget);
  const pathPart = match ? match[1] : rawTarget;
  const lineSuffix = match ? match[2] : '';
  const isScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(pathPart);
  const isWinDrive = /^[A-Za-z]:[\\/]/.test(pathPart) || /^\/[A-Za-z]:[\\/]/.test(pathPart);
  if (isScheme && !isWinDrive) {
    return labelHtml;
  }
  const uri = lookupFileUri(pathPart, fileLinksByPath);
  const lineBadge = lineSuffix ? `<span class="md-file-line">${escapeHtml(lineSuffix)}</span>` : '';
  if (uri) {
    return `<button type="button" class="md-file-link" data-file-uri="${escapeHtml(uri)}" title="${escapeHtml(rawTarget)}">${labelHtml}${lineBadge}</button>`;
  }
  return `<span class="md-file-ref" title="${escapeHtml(rawTarget)}">${labelHtml}${lineBadge}</span>`;
}

function formatInline(escapedText, fileLinksByPath) {
  const codeSpans = [];
  let text = escapedText.replace(/`([^`\n]+)`/g, (_match, code) => {
    const token = `\u0000CODE${codeSpans.length}\u0000`;
    codeSpans.push(`<code class="inline-code">${code}</code>`);
    return token;
  });

  text = text.replace(/\[([^\]\r\n]+)\]\(\s*(?:&lt;([^&<>\r\n]+)&gt;|([^\s()<>]+))\s*\)/g, (_match, label, angled, plain) => {
    const rawTarget = (angled ?? plain ?? '').replace(/&amp;/g, '&').trim();
    if (!rawTarget) return label;
    if (/^https?:\/\//i.test(rawTarget)) {
      return `<a class="md-link" href="${escapeHtml(rawTarget)}" data-ext-link="${escapeHtml(rawTarget)}" rel="noopener noreferrer">${label}</a>`;
    }
    if (/^(?:javascript|vbscript|data):/i.test(rawTarget)) {
      return label;
    }
    return renderLocalFileRef(label, rawTarget, fileLinksByPath);
  });

  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  return text.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx) => codeSpans[Number(idx)] ?? '');
}

function renderParagraphLines(lines, fileLinksByPath) {
  const escaped = lines.map((line) => formatInline(escapeHtml(line), fileLinksByPath));
  return `<p>${escaped.join('<br />')}</p>`;
}

const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?(?:\s*\|\s*:?-{2,}:?)*\s*\|?\s*$/;

function splitTableCells(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  const cells = [];
  let current = '';
  let inCode = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === '`' && trimmed[i - 1] !== '\\') {
      inCode = !inCode;
      current += ch;
    } else if (ch === '\\' && trimmed[i + 1] === '|') {
      current += '|';
      i += 1;
    } else if (ch === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseTableAlignments(sepLine) {
  return splitTableCells(sepLine).map((cell) => {
    const c = cell.trim();
    if (c.startsWith(':') && c.endsWith(':')) return 'center';
    if (c.endsWith(':')) return 'right';
    return 'left';
  });
}

function isTableStart(lines, idx) {
  if (idx + 1 >= lines.length) return false;
  const head = lines[idx];
  const sep = lines[idx + 1];
  if (!head.includes('|') || !sep.includes('-') || !TABLE_SEP_RE.test(sep)) return false;
  const headCols = splitTableCells(head).length;
  const sepCols = splitTableCells(sep).length;
  return headCols >= 1 && headCols === sepCols;
}

export function renderMarkdown(source, copyLabelOrOpts = 'Copy') {
  const opts = typeof copyLabelOrOpts === 'string' ? { copyLabel: copyLabelOrOpts } : (copyLabelOrOpts ?? {});
  const copyLabel = opts.copyLabel ?? 'Copy';
  const fileLinksByPath = opts.fileLinksByPath ?? null;

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

    if (isTableStart(lines, i)) {
      const headers = splitTableCells(lines[i]);
      const aligns = parseTableAlignments(lines[i + 1]);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|') && !/^```/.test(lines[i].trim())) {
        bodyRows.push(splitTableCells(lines[i]));
        i += 1;
      }
      const thHtml = headers
        .map((cell, colIdx) => `<th style="text-align:${aligns[colIdx] ?? 'left'}">${formatInline(escapeHtml(cell), fileLinksByPath)}</th>`)
        .join('');
      const rowsHtml = bodyRows
        .map((cells) => `<tr>${headers.map((_, colIdx) => `<td style="text-align:${aligns[colIdx] ?? 'left'}">${formatInline(escapeHtml(cells[colIdx] ?? ''), fileLinksByPath)}</td>`).join('')}</tr>`)
        .join('');
      html.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${thHtml}</tr></thead>${bodyRows.length ? `<tbody>${rowsHtml}</tbody>` : ''}</table></div>`);
      continue;
    }

    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      html.push(`<h${level} class="md-h">${formatInline(escapeHtml(headingMatch[2]), fileLinksByPath)}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      html.push(`<blockquote class="md-quote">${renderParagraphLines(quoteLines, fileLinksByPath)}</blockquote>`);
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(`<li>${formatInline(escapeHtml(lines[i].replace(/^[-*]\s+/, '')), fileLinksByPath)}</li>`);
        i += 1;
      }
      html.push(`<ul class="md-list">${items.join('')}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${formatInline(escapeHtml(lines[i].replace(/^\d+\.\s+/, '')), fileLinksByPath)}</li>`);
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
      && !isTableStart(lines, i)
      && !/^(#{1,4})\s+/.test(lines[i])
      && !/^>\s?/.test(lines[i])
      && !/^[-*]\s+/.test(lines[i])
      && !/^\d+\.\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    html.push(renderParagraphLines(paraLines, fileLinksByPath));
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

export function parseDiffByFile(diffText) {
  const byFile = new Map();
  const unmatchedChunks = [];
  const raw = String(diffText ?? '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return { byFile, unmatchedChunks };

  const lines = raw.split('\n');
  let sections = [];
  let current = null;
  let preamble = [];

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current) sections.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) sections.push(current);

  if (sections.length === 0) {
    let hdrCurrent = null;
    const hdrSections = [];
    const leftovers = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        if (hdrCurrent) hdrSections.push(hdrCurrent);
        hdrCurrent = [lines[i], lines[i + 1]];
        i += 1;
      } else if (hdrCurrent) {
        hdrCurrent.push(lines[i]);
      } else {
        leftovers.push(lines[i]);
      }
    }
    if (hdrCurrent) hdrSections.push(hdrCurrent);
    if (hdrSections.length === 0) {
      unmatchedChunks.push(raw);
      return { byFile, unmatchedChunks };
    }
    sections = hdrSections;
    preamble = leftovers;
  }

  if (preamble.some((l) => l.trim())) {
    unmatchedChunks.push(preamble.join('\n').trim());
  }

  for (const secLines of sections) {
    let oldPath = '';
    let newPath = '';
    let isNew = false;
    let isDel = false;
    for (const line of secLines) {
      if (line.startsWith('diff --git ')) {
        const m = /^diff --git (?:"?a\/([^"]+)"?|a\/(\S+)) (?:"?b\/([^"]+)"?|b\/(\S+))$/.exec(line);
        if (m) {
          oldPath = m[1] || m[2] || '';
          newPath = m[3] || m[4] || '';
        }
      } else if (line.startsWith('new file mode ')) {
        isNew = true;
      } else if (line.startsWith('deleted file mode ')) {
        isDel = true;
      } else if (line.startsWith('--- ')) {
        const p = line.slice(4).trim().replace(/^"|"$/g, '');
        if (p === '/dev/null') isNew = true;
        else oldPath = p.startsWith('a/') ? p.slice(2) : p;
      } else if (line.startsWith('+++ ')) {
        const p = line.slice(4).trim().replace(/^"|"$/g, '');
        if (p === '/dev/null') isDel = true;
        else newPath = p.startsWith('b/') ? p.slice(2) : p;
      }
    }
    const resolvedPath = (isDel ? oldPath : (newPath || oldPath)).trim();
    const kind = isNew ? 'add' : isDel ? 'del' : 'mod';
    const sectionText = secLines.join('\n');
    if (resolvedPath) {
      const existing = byFile.get(resolvedPath);
      if (existing) {
        existing.diff = `${existing.diff}\n${sectionText}`;
      } else {
        byFile.set(resolvedPath, { path: resolvedPath, kind, diff: sectionText });
      }
    } else {
      unmatchedChunks.push(sectionText);
    }
  }

  return { byFile, unmatchedChunks };
}
