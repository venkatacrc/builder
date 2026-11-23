import { esc, renderMarkdown } from './markdown';
import type { AttachmentView, ChatInfo, ChatSnapshot, HostToWebview, Item, WebviewToHost } from '../shared/protocol';
import { QuotaBlock, formatClock, formatCountdown } from '../shared/quota';

declare function acquireVsCodeApi(): { postMessage(m: WebviewToHost): void; getState(): any; setState(s: any): void };
const vscode = acquireVsCodeApi();
const post = (m: WebviewToHost) => vscode.postMessage(m);

// ----------------------------------------------------------------------- state ---
let chats: ChatInfo[] = [];
let active: string | null = null;
const snaps = new Map<string, ChatSnapshot>();
let attachments: AttachmentView[] = [];
let mentionResults: AttachmentView[] = [];
let mentionIndex = 0;
let mentionReq = 0;
let mentionRange: { start: number; end: number } | null = null;
const history: string[] = [];
let historyPos = -1;
let trusted = true;
let quota: QuotaBlock | null = null;
let quotaTick: number | undefined;

const svg = (body: string) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON = {
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  history: svg('<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>'),
  clip: svg('<path d="M13 7.5 8.2 12.3a3 3 0 0 1-4.3-4.2l5-5a2 2 0 0 1 2.9 2.8l-5 5a1 1 0 0 1-1.4-1.4L10 4.9"/>'),
  send: svg('<path d="M8 13V3.5M4 7.5 8 3.5l4 4"/>'),
  stop: '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>',
};

const app = document.getElementById('app')!;
app.innerHTML = `
<header class="top">
  <span class="dot" id="dot"></span>
  <span class="title" id="title">New chat</span>
  <button class="icon" id="new" title="New chat (⌘⇧N)">${ICON.plus}</button>
  <button class="icon" id="history" title="History">${ICON.history}</button>
</header>
<div class="messages" id="messages" tabindex="0"></div>
<div class="composer">
  <div class="banner quota hidden" id="quota"></div>
  <div class="banner hidden" id="trust"><span>Restricted Mode: Code Puppy starts after you trust this folder.</span><span class="spacer"></span><button class="mini" id="trustBtn">Trust…</button></div>
  <div class="banner hidden" id="banner"></div>
  <div class="card">
    <div class="chips" id="chips"></div>
    <textarea id="input" rows="1" placeholder="Ask Code Puppy… (@ to add context)" spellcheck="false"></textarea>
    <div class="bar">
      <select id="model" title="Model"></select>
      <button class="pill" id="auto" title="When on, the agent edits files and runs commands without asking">Auto</button>
      <span class="spacer"></span>
      <button class="icon" id="attach" title="Attach files or folders">${ICON.clip}</button>
      <button class="send" id="send" title="Send (Enter)">${ICON.send}</button>
    </div>
  </div>
  <div class="mentions hidden" id="mentions"></div>
  <div class="status" id="status"></div>
</div>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const titleEl = $('title'), dotEl = $('dot'), msgsEl = $('messages'), bannerEl = $('banner'), chipsEl = $('chips'), mentionsEl = $('mentions');
const inputEl = $<HTMLTextAreaElement>('input'), modelEl = $<HTMLSelectElement>('model');
const autoEl = $<HTMLButtonElement>('auto'), sendEl = $<HTMLButtonElement>('send'), statusEl = $('status');

const cur = () => (active ? snaps.get(active) : undefined);
const isBusy = (i?: ChatInfo) => i?.status === 'running' || i?.status === 'starting';

// ------------------------------------------------------------------- rendering ---

function renderHeader() {
  const info = chats.find((c) => c.id === active);
  titleEl.textContent = info?.title ?? 'New chat';
  titleEl.title = info ? `${info.title}\n${info.cwd}` : '';
  dotEl.className = `dot ${info?.status ?? ''}`;
}

function renderComposerState() {
  const snap = cur();
  const info = snap?.info;
  const busy = isBusy(info);
  const running = info?.status === 'running';
  sendEl.innerHTML = running ? ICON.stop : ICON.send;
  sendEl.title = running ? 'Stop (Esc)' : 'Send (Enter)';
  sendEl.classList.toggle('stop', running);
  statusEl.textContent = info?.statusText ?? (running ? 'Working…' : '');
  statusEl.className = 'status ' + (info?.status ?? '');
  autoEl.classList.toggle('on', !!info?.autoApprove);

  // model select
  const models = [...(snap?.models ?? [])];
  modelEl.innerHTML = '';
  const ids = new Set(models.map((m) => m.id));
  if (info?.model && !ids.has(info.model)) models.unshift({ id: info.model, name: info.model });
  if (!models.length) models.push({ id: '', name: 'model…' });
  for (const m of models) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.name;
    if (m.description) o.title = m.description;
    if (m.id === info?.model) o.selected = true;
    modelEl.appendChild(o);
  }
  modelEl.disabled = !info || busy;

  // changes banner
  const n = info?.pendingChanges ?? 0;
  if (n > 0 && info) {
    bannerEl.classList.remove('hidden');
    bannerEl.innerHTML = `<span><b>${n}</b> file${n === 1 ? '' : 's'} changed by the agent</span><span class="spacer"></span><button class="mini" data-act="review">Review</button><button class="mini" data-act="keep">Keep all</button><button class="mini danger" data-act="undo">Undo all</button>`;
  } else {
    bannerEl.classList.add('hidden');
  }
}

function renderQuota() {
  const el = $('quota');
  if (!quota) {
    window.clearInterval(quotaTick);
    quotaTick = undefined;
    el.classList.add('hidden');
    return;
  }
  const what = esc(quota.model ?? 'model');
  const left = quota.until - Date.now();
  el.classList.remove('hidden');
  el.title = quota.message;
  if (left > 0) {
    el.classList.remove('ready');
    el.innerHTML = `<span class="clock">${formatCountdown(left)}</span><span class="what"><b>${what}</b> · ready at ${formatClock(quota.until)}</span><button class="mini" data-q="dismiss" title="Hide">✕</button>`;
    quotaTick ??= window.setInterval(renderQuota, 1000);
  } else {
    window.clearInterval(quotaTick);
    quotaTick = undefined;
    el.classList.add('ready');
    el.innerHTML = `<span class="clock">Ready</span><span class="what"><b>${what}</b> quota is back</span><button class="mini" data-q="continue">Continue</button><button class="mini" data-q="dismiss" title="Hide">✕</button>`;
  }
}

function nearBottom() {
  return msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 80;
}
function scrollBottom() {
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

function itemEl(item: Item): HTMLElement {
  const el = document.createElement('div');
  el.dataset.id = item.id;
  fillItem(el, item);
  return el;
}

const KIND_ICON: Record<string, string> = { read: '📄', edit: '✏️', delete: '🗑', search: '🔎', execute: '⌘', think: '💭', fetch: '🌐', other: '⚙' };

function fillItem(el: HTMLElement, item: Item) {
  el.className = `item ${item.kind}`;
  switch (item.kind) {
    case 'user': {
      const chips = (item.attachments ?? []).map((a) => `<span class="chip ro" title="${esc(a.detail ?? '')}">${esc(a.label)}</span>`).join('');
      el.innerHTML = `<div class="bubble">${esc(item.text).replace(/\n/g, '<br>')}</div>${chips ? `<div class="chips">${chips}</div>` : ''}`;
      break;
    }
    case 'assistant':
      el.innerHTML = `<div class="md">${renderMarkdown(item.text)}</div>`;
      break;
    case 'thought':
      el.innerHTML = `<details><summary>Thinking</summary><div class="md muted">${renderMarkdown(item.text)}</div></details>`;
      break;
    case 'tool': {
      const icon = item.status === 'failed' ? '✖' : item.status === 'completed' ? '✔' : '<span class="spin"></span>';
      const diff = item.diff ? `<pre class="diff">${diffHtml(item.diff)}</pre>` : '';
      const detail = item.detail ? `<pre class="out">${esc(item.detail)}</pre>` : '';
      const body = diff || detail ? `<div class="tool-body">${diff}${detail}</div>` : '';
      const title = item.path ? `<a href="#" class="file" data-path="${esc(item.path)}" data-line="${item.line ?? ''}">${esc(item.title)}</a>` : esc(item.title);
      el.innerHTML = `<details class="tool-card ${item.status}" ${item.diff ? 'open' : ''}><summary><span class="ti">${KIND_ICON[item.toolKind] ?? '⚙'}</span><span class="tt">${title}</span><span class="ts">${icon}</span></summary>${body}</details>`;
      break;
    }
    case 'permission': {
      const buttons = item.resolved
        ? `<span class="resolved">${esc(item.resolved)}</span>`
        : item.options
            .map((o) => `<button class="btn ${o.kind.startsWith('reject') ? 'danger' : 'primary'}" data-req="${esc(item.requestId)}" data-opt="${esc(o.id)}">${esc(o.name)}</button>`)
            .join('');
      el.innerHTML = `<div class="perm"><div class="perm-title">⚠ ${esc(item.title)}</div><div class="perm-actions">${buttons}</div></div>`;
      break;
    }
    case 'notice':
      el.innerHTML = `<div class="notice ${item.level}">${esc(item.text).replace(/\n/g, '<br>')}</div>`;
      break;
  }
}

function diffHtml(d: string): string {
  return d
    .split('\n')
    .map((l) => {
      const c = l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : '';
      return `<span class="${c}">${esc(l)}</span>`;
    })
    .join('\n');
}

function renderAll() {
  const snap = cur();
  msgsEl.innerHTML = '';
  if (!snap) return;
  if (snap.items.length === 0) {
    const starters = ['Explain this file', 'Find and fix a bug in the selection', 'Write tests for this file', 'Summarize this project'];
    msgsEl.innerHTML = `<div class="empty"><h3>Code Puppy</h3><p>Build, edit, explain and debug with your code-puppy agent.</p><div class="starters">${starters
      .map((s) => `<button class="starter" data-starter="${esc(s)}">${esc(s)}</button>`)
      .join('')}</div><p class="hint">Edits land in your files for review: keep or undo them anytime.</p></div>`;
  }
  for (const it of snap.items) msgsEl.appendChild(itemEl(it));
  scrollBottom();
}

function findEl(id: string): HTMLElement | null {
  return msgsEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
}

const pendingRender = new Map<string, Item>();
let raf = 0;
function scheduleRender(item: Item) {
  pendingRender.set(item.id, item);
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const stick = nearBottom();
    for (const it of pendingRender.values()) {
      const el = findEl(it.id);
      if (el) fillItem(el, it);
    }
    pendingRender.clear();
    if (stick) scrollBottom();
  });
}

// ------------------------------------------------------------- host messages ---

window.addEventListener('message', (ev) => {
  const m = ev.data as HostToWebview;
  switch (m.t) {
    case 'chats':
      chats = m.chats;
      active = m.active;
      renderHeader();
      break;
    case 'snapshot':
      snaps.set(m.chatId, m.snapshot);
      if (m.chatId === active) {
        renderAll();
        renderComposerState();
      }
      break;
    case 'item': {
      const snap = snaps.get(m.chatId);
      if (!snap) break;
      const idx = snap.items.findIndex((i) => i.id === m.item.id);
      if (idx >= 0) snap.items[idx] = m.item;
      else snap.items.push(m.item);
      if (m.chatId !== active) break;
      const existing = findEl(m.item.id);
      if (existing) scheduleRender(m.item);
      else {
        const stick = nearBottom();
        if (snap.items.length === 1) msgsEl.innerHTML = '';
        msgsEl.appendChild(itemEl(m.item));
        if (stick || m.item.kind === 'user') scrollBottom();
      }
      break;
    }
    case 'append': {
      const snap = snaps.get(m.chatId);
      const it = snap?.items.find((i) => i.id === m.itemId);
      if (!it || (it.kind !== 'assistant' && it.kind !== 'thought')) break;
      // host and webview both keep the transcript; keep ours in sync
      it.text += m.text;
      if (m.chatId === active) scheduleRender(it);
      break;
    }
    case 'info': {
      const i = chats.findIndex((c) => c.id === m.info.id);
      if (i >= 0) chats[i] = m.info;
      else chats.push(m.info);
      const s = snaps.get(m.info.id);
      if (s) {
        s.info = m.info;
        if (m.models?.length) s.models = m.models;
      }
      renderHeader();
      if (m.info.id === active) renderComposerState();
      break;
    }
    case 'attachment':
      if (!attachments.some((a) => a.id === m.attachment.id)) attachments.push(m.attachment);
      renderChips();
      inputEl.focus();
      break;
    case 'mentions':
      if (m.reqId === mentionReq) {
        mentionResults = m.results;
        mentionIndex = 0;
        renderMentions();
      }
      break;
    case 'focusInput':
      inputEl.focus();
      break;
    case 'prefill':
      inputEl.value = m.text;
      inputEl.focus();
      autosize();
      break;
    case 'trust':
      trusted = m.trusted;
      $('trust').classList.toggle('hidden', trusted);
      break;
    case 'quota':
      quota = m.quota;
      renderQuota();
      break;
  }
});

// ---------------------------------------------------------------- composer ---

function renderChips() {
  chipsEl.innerHTML = '';
  for (const a of attachments) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.title = a.detail ?? a.label;
    const icon = { file: '📄', folder: '📁', selection: '✂', problems: '⚠', image: '🖼', active: '📌' }[a.kind];
    c.innerHTML = `${a.thumb ? `<img src="${a.thumb}">` : icon} ${esc(a.label)} <span class="x">×</span>`;
    c.querySelector('.x')!.addEventListener('click', () => {
      attachments = attachments.filter((x) => x.id !== a.id);
      renderChips();
    });
    chipsEl.appendChild(c);
  }
}

function renderMentions() {
  if (!mentionResults.length || !mentionRange) {
    mentionsEl.classList.add('hidden');
    return;
  }
  mentionsEl.classList.remove('hidden');
  mentionsEl.innerHTML = '';
  mentionResults.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'mention' + (i === mentionIndex ? ' sel' : '');
    const icon = { file: '📄', folder: '📁', selection: '✂', problems: '⚠', image: '🖼', active: '📌' }[r.kind];
    row.innerHTML = `<span>${icon} ${esc(r.label)}</span><span class="d">${esc(r.detail ?? '')}</span>`;
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pickMention(i);
    });
    mentionsEl.appendChild(row);
  });
}

function pickMention(i: number) {
  const r = mentionResults[i];
  if (!r || !mentionRange) return;
  if (!attachments.some((a) => a.id === r.id)) attachments.push(r);
  const v = inputEl.value;
  inputEl.value = v.slice(0, mentionRange.start) + v.slice(mentionRange.end);
  inputEl.setSelectionRange(mentionRange.start, mentionRange.start);
  closeMentions();
  renderChips();
}

function closeMentions() {
  mentionRange = null;
  mentionResults = [];
  mentionsEl.classList.add('hidden');
}

function checkMention() {
  const pos = inputEl.selectionStart;
  const before = inputEl.value.slice(0, pos);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return closeMentions();
  mentionRange = { start: pos - m[2].length - 1, end: pos };
  post({ t: 'searchMentions', reqId: ++mentionReq, query: m[2] });
}

function autosize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(240, Math.max(36, inputEl.scrollHeight)) + 'px';
}

function submit() {
  const snap = cur();
  if (!snap) return;
  if (snap.info.status === 'running') {
    post({ t: 'cancel', chatId: snap.info.id });
    return;
  }
  if (!trusted) {
    post({ t: 'manageTrust' });
    return;
  }
  const text = inputEl.value.trim();
  if (!text && attachments.length === 0) return;
  if (text) {
    history.unshift(text);
    historyPos = -1;
  }
  post({ t: 'send', chatId: snap.info.id, text, attachmentIds: attachments.map((a) => a.id) });
  inputEl.value = '';
  attachments = [];
  renderChips();
  closeMentions();
  autosize();
}

inputEl.addEventListener('input', () => {
  autosize();
  checkMention();
});
inputEl.addEventListener('keydown', (e) => {
  if (!mentionsEl.classList.contains('hidden') && mentionResults.length) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      mentionIndex = (mentionIndex + 1) % mentionResults.length;
      return renderMentions();
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      mentionIndex = (mentionIndex - 1 + mentionResults.length) % mentionResults.length;
      return renderMentions();
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      return pickMention(mentionIndex);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      return closeMentions();
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  } else if (e.key === 'ArrowUp' && inputEl.value === '' && history.length) {
    e.preventDefault();
    historyPos = Math.min(history.length - 1, historyPos + 1);
    inputEl.value = history[historyPos];
  } else if (e.key === 'Escape' && cur()?.info.status === 'running') {
    post({ t: 'cancel', chatId: cur()!.info.id });
  }
});
inputEl.addEventListener('blur', () => setTimeout(closeMentions, 100));
inputEl.addEventListener('paste', (e) => {
  for (const item of Array.from(e.clipboardData?.items ?? [])) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        post({ t: 'addImage', name: file.name || 'pasted-image.png', mime: file.type, data: url.slice(url.indexOf(',') + 1) });
      };
      reader.readAsDataURL(file);
    }
  }
});

sendEl.addEventListener('click', submit);
$('attach').addEventListener('click', () => post({ t: 'pickFile' }));
modelEl.addEventListener('change', () => active && post({ t: 'setModel', chatId: active, model: modelEl.value }));
autoEl.addEventListener('click', () => active && post({ t: 'setAutoApprove', chatId: active, value: !autoEl.classList.contains('on') }));
$('new').addEventListener('click', () => post({ t: 'newChat' }));
$('history').addEventListener('click', () => post({ t: 'showSessions' }));
$('trustBtn').addEventListener('click', () => post({ t: 'manageTrust' }));
$('quota').addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest('button')?.dataset.q;
  if (act === 'dismiss') post({ t: 'dismissQuota' });
  else if (act === 'continue' && active && trusted && !isBusy(cur()?.info)) post({ t: 'send', chatId: active, text: 'continue', attachmentIds: [] });
});

bannerEl.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).dataset.act;
  if (!act || !active) return;
  post({ t: act === 'review' ? 'reviewChanges' : act === 'keep' ? 'keepAll' : 'undoAll', chatId: active });
});

msgsEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const file = t.closest('a.file') as HTMLElement | null;
  if (file) {
    e.preventDefault();
    post({ t: 'openFile', path: file.dataset.path!, line: file.dataset.line ? Number(file.dataset.line) : undefined });
    return;
  }
  // External links (a.ext): the default action is right; VS Code opens http(s) links in the browser.
  const btn = t.closest('button') as HTMLButtonElement | null;
  if (!btn) return;
  if (btn.dataset.starter) {
    inputEl.value = btn.dataset.starter;
    autosize();
    inputEl.focus();
    return;
  }
  if (btn.dataset.req && active) {
    post({ t: 'permission', chatId: active, requestId: btn.dataset.req, optionId: btn.dataset.opt! });
    return;
  }
  const act = btn.dataset.act;
  if (act === 'copy' || act === 'insert') {
    const code = btn.closest('.code')?.querySelector('code')?.textContent ?? '';
    post({ t: act === 'copy' ? 'copy' : 'insertCode', text: code });
    if (act === 'copy') {
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = 'Copy'), 1200);
    }
  }
});

renderHeader();
renderComposerState();
post({ t: 'ready' });
