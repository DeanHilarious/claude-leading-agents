// 安全 Markdown 渲染：先转义全部 HTML，再用有限语法生成受控标签。
// 链接仅允许 http/https。绝不把未转义内容拼进 HTML。

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 行内：代码、链接、粗体、斜体
function inline(s) {
  let out = '';
  let rest = s;
  const re = /(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)/;
  while (rest) {
    const m = rest.match(re);
    if (!m) { out += escapeHtml(rest); break; }
    out += escapeHtml(rest.slice(0, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) {
      out += '<code>' + escapeHtml(tok.slice(1, -1)) + '</code>';
    } else if (tok.startsWith('[')) {
      const mm = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      const url = mm ? mm[2] : '';
      const text = mm ? mm[1] : tok;
      if (/^https?:\/\//i.test(url)) {
        out += '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(text) + '</a>';
      } else {
        out += escapeHtml(text);
      }
    } else if (tok.startsWith('**')) {
      out += '<strong>' + inline(tok.slice(2, -2)) + '</strong>';
    } else {
      out += '<em>' + escapeHtml(tok.slice(1, -1)) + '</em>';
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

function splitRow(line) {
  return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

function isTableSep(line) {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-') && line.includes('|');
}

function renderTable(head, rows) {
  let html = '<table><thead><tr>';
  for (const h of head) html += '<th>' + inline(h) + '</th>';
  html += '</tr></thead><tbody>';
  for (const r of rows) {
    html += '<tr>';
    for (let k = 0; k < head.length; k++) html += '<td>' + inline(r[k] || '') + '</td>';
    html += '</tr>';
  }
  return html + '</tbody></table>';
}

// 列表（支持嵌套一层）。返回 { html, next }
function renderList(lines, i, ordered) {
  const items = [];
  let j = i;
  let baseIndent = null;
  while (j < lines.length) {
    const m = lines[j].match(/^(\s*)([-*]|(\d+)\.)\s+(.*)$/);
    if (!m) break;
    const indent = m[1].length;
    const isOrd = m[3] !== undefined;
    if (baseIndent === null) {
      baseIndent = indent;
    } else if (indent < baseIndent || (indent === baseIndent && isOrd !== ordered)) {
      break;
    }
    items.push({ indent, isOrd, text: m[4] });
    j++;
  }
  const tag = ordered ? 'ol' : 'ul';
  let html = '<' + tag + '>';
  let k = 0;
  while (k < items.length) {
    let sub = '';
    if (k + 1 < items.length && items[k + 1].indent > baseIndent) {
      // 嵌套一层：连续更深的项合成子列表，类型按第一项
      const ntag = items[k + 1].isOrd ? 'ol' : 'ul';
      sub = '<' + ntag + '>';
      while (k + 1 < items.length && items[k + 1].indent > baseIndent) {
        k++;
        sub += '<li>' + inline(items[k].text) + '</li>';
      }
      sub += '</' + ntag + '>';
    }
    html += '<li>' + inline(items[k].text) + sub + '</li>';
    k++;
  }
  return { html: html + '</' + tag + '>', next: j };
}

function isBlockStart(line, nextLine) {
  return /^(#{1,6}\s|```|>|\s*[-*]\s|\s*\d+\.\s)/.test(line) ||
    (line.includes('|') && nextLine !== undefined && isTableSep(nextLine));
}

function render(text) {
  if (text == null) return '';
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const t = line.trim();
    // 代码块
    if (t.startsWith('```')) {
      const lang = t.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i++; }
      i++; // 结尾 ```
      html += '<pre data-lang="' + escapeHtml(lang) + '"><code>' + escapeHtml(buf.join('\n')) + '</code></pre>';
      continue;
    }
    // 分隔线
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(t)) { html += '<hr>'; i++; continue; }
    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lv = h[1].length;
      html += '<h' + lv + '>' + inline(h[2]) + '</h' + lv + '>';
      i++; continue;
    }
    // 引用
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      html += '<blockquote>' + render(buf.join('\n')) + '</blockquote>';
      continue;
    }
    // 表格
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line.trim());
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i].trim())); i++;
      }
      html += renderTable(head, rows);
      continue;
    }
    // 列表
    if (/^\s*[-*]\s+/.test(line)) {
      const r = renderList(lines, i, false);
      html += r.html; i = r.next; continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const r = renderList(lines, i, true);
      html += r.html; i = r.next; continue;
    }
    // 段落
    const buf = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) {
      buf.push(lines[i]); i++;
    }
    html += '<p>' + inline(buf.join('\n')) + '</p>';
  }
  return html;
}

export { render, escapeHtml };
