/**
 * Tiny, safe markdown -> HTML renderer for chat messages.
 *
 * Safety model: all text is HTML-escaped *first*; only a fixed set of tags is ever
 * produced by us, links are limited to http(s)/mailto, and code is always escaped.
 * (No dependency on a sanitizer; there is no path for model output to inject markup.)
 */

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const FILE_RE = /^(?:\.{0,2}\/)?[\w@.\-+/]+\.[A-Za-z0-9]{1,8}(?::(\d+)(?:[-:]\d+)?)?$/;

function inline(text: string): string {
  // text is already escaped
  let out = text;
  out = out.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const raw = code.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const m = FILE_RE.exec(raw);
    if (m && (raw.includes('/') || /\.[A-Za-z]{1,5}(:\d+)?$/.test(raw))) {
      const line = m[1] ?? '';
      const p = line ? raw.slice(0, raw.lastIndexOf(':' + line)) : raw;
      return `<a href="#" class="file" data-path="${esc(p)}" data-line="${line}"><code>${code}</code></a>`;
    }
    return `<code>${code}</code>`;
  });
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_m, label: string, url: string) => `<a href="${url}" class="ext">${label}</a>`);
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, pre: string, url: string) => `${pre}<a href="${url}" class="ext">${url}</a>`);
  return out;
}

function codeBlock(lang: string, code: string): string {
  const l = esc(lang || 'text');
  return `<div class="code"><div class="code-head"><span class="lang">${l}</span><span class="spacer"></span><button class="mini" data-act="copy">Copy</button><button class="mini" data-act="insert">Insert</button></div><pre><code>${esc(code.replace(/\n$/, ''))}</code></pre></div>`;
}

export function renderMarkdown(src: string): string {
  const blocks: string[] = [];
  const withoutFences = src.replace(/```([\w+#.-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g, (_m, lang: string, code: string) => {
    blocks.push(codeBlock(lang, code));
    return `\n\u0000B${blocks.length - 1}\u0000\n`;
  });

  const lines = esc(withoutFences).split('\n');
  const out: string[] = [];
  let i = 0;
  const flushPara = (buf: string[]) => {
    if (buf.length) out.push(`<p>${inline(buf.join('<br>'))}</p>`);
    buf.length = 0;
  };
  const para: string[] = [];

  while (i < lines.length) {
    const line = lines[i];
    const blockRef = /^\u0000B(\d+)\u0000$/.exec(line.trim());
    if (blockRef) {
      flushPara(para);
      out.push(blocks[Number(blockRef[1])]);
      i++;
      continue;
    }
    if (!line.trim()) {
      flushPara(para);
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara(para);
      const level = Math.min(6, h[1].length + 2);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushPara(para);
      out.push('<hr>');
      i++;
      continue;
    }
    // table
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flushPara(para);
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }
    // lists
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flushPara(para);
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (/^&gt;\s?/.test(line)) {
      flushPara(para);
      const q: string[] = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) q.push(lines[i++].replace(/^&gt;\s?/, ''));
      out.push(`<blockquote>${inline(q.join('<br>'))}</blockquote>`);
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara(para);
  return out.join('');
}
