import * as vscode from 'vscode';
import * as os from 'node:os';
import { AgentPool, AgentRuntime } from '../agent/runtime';
import { ContextResolver } from '../context/ContextResolver';
import { ChangeTracker } from '../edits/ChangeTracker';
import { TerminalManager } from '../terminal/TerminalManager';
import { Logger } from '../util/log';
import { settings } from '../config';
import { ChatEvents, ChatServices, ChatSession } from './ChatSession';
import type { HostToWebview, Item } from '../shared/protocol';
import type { QuotaBlock } from '../shared/quota';
import { SessionSummary, importCliSession, readTranscript } from '../puppy/files';

interface SessionMeta {
  title: string;
  agent?: string;
  model?: string;
  cwd?: string;
  updatedAt: number;
}

const INDEX_KEY = 'builder.sessionIndex';
const OPEN_KEY = 'builder.openChats';
const LAST_MODEL = 'builder.lastModel';
const QUOTA_KEY = 'builder.quota';
/** A countdown that finished while Builder was closed still shows "Ready" for this long. */
const QUOTA_READY_KEEP_MS = 12 * 3600_000;

/** Owns all chats, the shared services, and fan-out of transcript events to webviews. */
export class ChatManager implements ChatServices, ChatEvents, vscode.Disposable {
  readonly chats: ChatSession[] = [];
  activeId: string | null = null;
  private listeners = new Set<(m: HostToWebview) => void>();
  private reaper?: NodeJS.Timeout;
  private chatVisible: () => boolean = () => false;
  private reveal: () => void = () => {};
  private readonly _onDidChangeSessions = new vscode.EventEmitter<void>();
  readonly onDidChangeSessions = this._onDidChangeSessions.event;
  private quota?: QuotaBlock;
  private quotaTimer?: NodeJS.Timeout;
  private readonly _onDidChangeQuota = new vscode.EventEmitter<QuotaBlock | undefined>();
  /** Fires when a quota countdown starts, is cleared, or reaches zero. */
  readonly onDidChangeQuota = this._onDidChangeQuota.event;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    readonly runtime: AgentRuntime,
    readonly pool: AgentPool,
    readonly changes: ChangeTracker,
    readonly terminals: TerminalManager,
    readonly context: ContextResolver,
    readonly log: Logger,
  ) {
    this.reaper = setInterval(() => this.reapIdle(), 60_000);
    this.reaper.unref?.();
    changes.onDidChangeRecords(() => {
      for (const c of this.chats) c.refreshInfo();
    });
    const saved = ctx.globalState.get<QuotaBlock>(QUOTA_KEY);
    if (saved && Date.now() - saved.until < QUOTA_READY_KEEP_MS) this.setQuota(saved, false);
    else if (saved) void ctx.globalState.update(QUOTA_KEY, undefined);
  }

  bindView(opts: { isVisible: () => boolean; reveal: () => void }): void {
    this.chatVisible = opts.isVisible;
    this.reveal = opts.reveal;
  }

  // ------------------------------------------------------------ ChatServices ---

  ensureSlot(exclude: ChatSession): void {
    const live = this.chats.filter((c) => c !== exclude && c.isLive);
    const limit = Math.max(1, settings.maxAgentProcesses);
    // +1 for the spare process kept warm by the pool.
    let over = live.length + 1 - limit;
    if (over <= 0) return;
    const idle = live.filter((c) => !c.isBusy).sort((a, b) => a.lastActive - b.lastActive);
    for (const c of idle) {
      if (over-- <= 0) break;
      this.log.info(`[manager] stopping idle chat ${c.id} to respect builder.maxAgentProcesses`);
      c.stopProcess();
    }
  }

  isChatVisible(): boolean {
    return this.chatVisible();
  }

  revealChat(): void {
    this.reveal();
  }

  stockDefaultAgent(): string {
    const cat = this.ctx.globalState.get<{ defaultAgent: string | null }>('builder.catalog');
    return cat?.defaultAgent || 'code-puppy';
  }

  reportQuota(q: QuotaBlock): void {
    this.log.info(`[manager] quota hit (${q.model ?? 'model'}): ready at ${new Date(q.until).toISOString()}`);
    this.setQuota(q);
  }

  noteTurnStarted(): void {
    if (this.quota && this.quota.until <= Date.now()) this.setQuota(undefined);
  }

  // ---------------------------------------------------------------------- quota ---

  get currentQuota(): QuotaBlock | undefined {
    return this.quota;
  }

  dismissQuota(): void {
    this.setQuota(undefined);
  }

  private setQuota(q: QuotaBlock | undefined, save = true): void {
    this.quota = q;
    clearTimeout(this.quotaTimer);
    this.quotaTimer = undefined;
    if (save) void this.ctx.globalState.update(QUOTA_KEY, q);
    const left = q ? q.until - Date.now() : 0;
    if (q && left > 0) this.quotaTimer = setTimeout(() => this.onQuotaReady(), Math.min(left, 2 ** 31 - 1));
    this.broadcast({ t: 'quota', quota: q ?? null });
    this._onDidChangeQuota.fire(q);
  }

  private onQuotaReady(): void {
    const q = this.quota;
    if (!q) return;
    this._onDidChangeQuota.fire(q);
    const what = q.model ? `${q.model} quota` : 'model quota';
    void vscode.window.showInformationMessage(`Builder is ready: the ${what} should be available again.`, 'Continue').then((pick) => {
      if (pick) void this.continueAfterQuota();
    });
  }

  /** Re-run the interrupted turn with "continue" in the current chat. */
  async continueAfterQuota(): Promise<void> {
    this.revealChat();
    const chat = this.active();
    if (!chat || chat.isBusy) return;
    await chat.send('continue', []);
  }

  // ----------------------------------------------------------------- ChatEvents ---

  item(chat: ChatSession, item: Item): void {
    this.broadcast({ t: 'item', chatId: chat.id, item });
  }
  append(chat: ChatSession, itemId: string, text: string): void {
    this.broadcast({ t: 'append', chatId: chat.id, itemId, text });
  }
  info(chat: ChatSession): void {
    this.broadcast({ t: 'info', info: chat.info(), models: chat.models });
  }

  // ------------------------------------------------------------------ messaging ---

  addListener(fn: (m: HostToWebview) => void): vscode.Disposable {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  broadcast(m: HostToWebview): void {
    for (const l of this.listeners) l(m);
  }

  broadcastChats(): void {
    this.broadcast({ t: 'chats', chats: this.chats.map((c) => c.info()), active: this.activeId });
  }

  active(): ChatSession | undefined {
    return this.chats.find((c) => c.id === this.activeId);
  }

  get(id: string): ChatSession | undefined {
    return this.chats.find((c) => c.id === id);
  }

  // -------------------------------------------------------------------- actions ---

  private defaultCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  }

  private additionalDirs(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).slice(1).map((f) => f.uri.fsPath);
  }

  /** Ask before abandoning a response that is still streaming. */
  async confirmLeave(): Promise<boolean> {
    const cur = this.active();
    if (!cur?.isBusy) return true;
    const pick = await vscode.window.showWarningMessage('Builder is still working on the current chat. Stop it?', { modal: true }, 'Stop and continue');
    return pick === 'Stop and continue';
  }

  /** Builder shows one conversation at a time; older ones stay saved in History. */
  private replaceWith(chat: ChatSession): void {
    for (const c of this.chats.splice(0)) if (c !== chat) c.dispose();
    this.chats.push(chat);
    this.select(chat.id);
  }

  newChat(): ChatSession {
    const cur = this.active();
    if (cur && !cur.hasContent && !cur.isBusy) {
      this.select(cur.id);
      return cur;
    }
    const chat = new ChatSession(this, this, {
      cwd: this.defaultCwd(),
      additionalDirs: this.additionalDirs(),
      model: settings.defaultModel || this.ctx.globalState.get<string>(LAST_MODEL) || undefined,
    });
    this.replaceWith(chat);
    this.startEagerly(chat);
    return chat;
  }

  /** Start the session eagerly so the model list is real and the first message is instant. */
  private startEagerly(chat: ChatSession): void {
    if (!vscode.workspace.isTrusted) return;
    this.pool.prewarm();
    void chat.ensureStarted().catch((e) => {
      this.log.error('eager start failed', e);
      chat.addNotice('error', (e as Error).message);
      chat.refreshInfo();
    });
  }

  onTrustGranted(): void {
    this.broadcast({ t: 'trust', trusted: true });
    const chat = this.active();
    if (chat && !chat.isLive) this.startEagerly(chat);
    else this.pool.prewarm();
  }

  select(id: string): void {
    this.activeId = id;
    const chat = this.get(id);
    this.broadcastChats();
    if (chat) this.broadcast({ t: 'snapshot', chatId: id, snapshot: chat.snapshot() });
    void this.saveOpen();
  }

  /** Open a saved session (Builder or terminal/CLI) in place of the current chat. */
  openSession(summary: SessionSummary): ChatSession {
    let sessionId = summary.id;
    const file = summary.file; // transcript is read from the original file
    if (summary.source === 'cli') sessionId = importCliSession(settings.configDir, summary, this.defaultCwd());
    const existing = this.chats.find((c) => c.persistentSessionId === sessionId);
    if (existing) {
      this.select(existing.id);
      return existing;
    }
    const meta = this.getIndex()[sessionId];
    const chat = new ChatSession(this, this, {
      cwd: summary.cwd && summary.cwd.length ? summary.cwd : this.defaultCwd(),
      additionalDirs: [],
      resumeSessionId: sessionId,
      title: summary.title,
      model: meta?.model,
    });
    chat.preload(readTranscript(file));
    this.replaceWith(chat);
    return chat;
  }

  // ----------------------------------------------------------------- persistence ---

  private getIndex(): Record<string, SessionMeta> {
    return this.ctx.globalState.get<Record<string, SessionMeta>>(INDEX_KEY, {});
  }

  titles(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.getIndex()).map(([k, v]) => [k, v.title]));
  }

  persistMeta(chat: ChatSession): void {
    const sid = chat.persistentSessionId;
    if (!sid) return;
    const index = this.getIndex();
    index[sid] = { title: chat.title, agent: chat.agent, model: chat.model, cwd: chat.cwd, updatedAt: Date.now() };
    void this.ctx.globalState.update(INDEX_KEY, index);
    if (chat.model) void this.ctx.globalState.update(LAST_MODEL, chat.model);
    void this.saveOpen();
    this._onDidChangeSessions.fire();
  }

  private async saveOpen(): Promise<void> {
    const c = this.active();
    const open = c?.persistentSessionId ? [{ sessionId: c.persistentSessionId, title: c.title, cwd: c.cwd, model: c.model, active: true }] : [];
    await this.ctx.workspaceState.update(OPEN_KEY, open);
  }

  /** Re-open the chat that was open when the window last closed (it starts sleeping). */
  restoreOpenChats(findFile: (sessionId: string) => string | undefined): void {
    const open = this.ctx.workspaceState.get<{ sessionId: string; title: string; cwd: string; model?: string; active?: boolean }[]>(OPEN_KEY, []);
    const o = open.find((x) => x.active) ?? open[0];
    const file = o && findFile(o.sessionId);
    if (!o || !file) return;
    const chat = new ChatSession(this, this, { cwd: o.cwd, resumeSessionId: o.sessionId, title: o.title, model: o.model });
    chat.preload(readTranscript(file));
    this.replaceWith(chat);
  }

  // ------------------------------------------------------------------- lifecycle ---

  private reapIdle(): void {
    const mins = settings.idleTimeoutMinutes;
    if (!mins) return;
    const cutoff = Date.now() - mins * 60_000;
    for (const c of this.chats) {
      if (c.isLive && !c.isBusy && c.lastActive < cutoff) {
        this.log.info(`[manager] idle timeout: stopping chat ${c.id}`);
        c.stopProcess();
      }
    }
  }

  async restartAgents(): Promise<void> {
    for (const c of this.chats) c.stopProcess('Agent restarted — resumes on next message');
    this.runtime.resetInstallCache();
    this.runtime.invalidateCatalog();
    await this.pool.reset();
  }

  dispose(): void {
    if (this.reaper) clearInterval(this.reaper);
    clearTimeout(this.quotaTimer);
    this._onDidChangeQuota.dispose();
    for (const c of this.chats) c.dispose();
    void this.pool.dispose();
    this._onDidChangeSessions.dispose();
  }
}
