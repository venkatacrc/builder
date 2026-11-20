import * as vscode from 'vscode';
import * as path from 'node:path';
import type { AcpAgent } from '../acp/agent';
import type {
  ClientHandlers,
  ConfigOption,
  PermissionOutcome,
  PermissionRequest,
  SessionUpdate,
  ToolCallContent,
} from '../acp/types';
import type { AgentPool, AgentRuntime, PooledAgent } from '../agent/runtime';
import type { ContextResolver } from '../context/ContextResolver';
import { ChangeTracker } from '../edits/ChangeTracker';
import type { TerminalManager } from '../terminal/TerminalManager';
import type { ChatInfo, ChatSnapshot, ChatStatus, Item, ModelChoice } from '../shared/protocol';
import { Logger, uid } from '../util/log';
import { settings } from '../config';
import { TranscriptEntry, stripBuilderContext } from '../puppy/files';

export interface ChatServices {
  pool: AgentPool;
  runtime: AgentRuntime;
  changes: ChangeTracker;
  terminals: TerminalManager;
  context: ContextResolver;
  log: Logger;
  ensureSlot(exclude: ChatSession): void;
  persistMeta(chat: ChatSession): void;
  isChatVisible(): boolean;
  revealChat(): void;
  /** Agent a stock `code-puppy --acp` process starts with (when the launcher can't pin one). */
  stockDefaultAgent(): string;
}

export interface ChatEvents {
  item(chat: ChatSession, item: Item): void;
  append(chat: ChatSession, itemId: string, text: string): void;
  info(chat: ChatSession): void;
}

export interface ChatInit {
  cwd: string;
  additionalDirs?: string[];
  /** Existing ACP session to resume (history is replayed into the transcript). */
  resumeSessionId?: string;
  title?: string;
  model?: string;
}

const MAX_DETAIL = 4000;

export class ChatSession {
  readonly id = uid('chat');
  title: string;
  status: ChatStatus = 'idle';
  statusText?: string;
  items: Item[] = [];
  cwd: string;
  additionalDirs: string[];
  sessionId?: string;
  model?: string;
  agent: string;
  autoApprove: boolean;
  models: ModelChoice[] = [];
  lastActive = Date.now();
  /** True once the user sent at least one message (or a history replay produced content). */
  hasContent = false;

  private pooled?: PooledAgent;
  private resumeId?: string;
  private suppress = 0;
  private suppressedText = '';
  private itemSeq = 0;
  private curAssistant?: Extract<Item, { kind: 'assistant' }>;
  private curThought?: Extract<Item, { kind: 'thought' }>;
  private tools = new Map<string, Extract<Item, { kind: 'tool' }>>();
  private permissionResolvers = new Map<string, { resolve: (o: PermissionOutcome) => void; item: Extract<Item, { kind: 'permission' }>; options: PermissionRequest['options'] }>();
  private outsideWorkspaceAllowed = false;
  private titleLocked = false;
  private starting?: Promise<void>;

  constructor(private readonly svc: ChatServices, private readonly events: ChatEvents, init: ChatInit) {
    this.cwd = init.cwd;
    this.additionalDirs = init.additionalDirs ?? [];
    this.resumeId = init.resumeSessionId;
    this.title = init.title ?? 'New chat';
    this.titleLocked = !!init.title;
    this.model = init.model || undefined;
    this.agent = settings.agent;
    this.autoApprove = settings.autoApprove;
    if (init.resumeSessionId) {
      this.sessionId = undefined; // set when loaded
      this.hasContent = true;
    }
  }

  /** Show a saved conversation immediately (the agent process is only needed once you send a message). */
  preload(entries: TranscriptEntry[]): void {
    for (const e of entries) {
      if (e.kind === 'user') this.items.push({ id: this.nextId(), kind: 'user', text: e.text });
      else if (e.kind === 'assistant') this.items.push({ id: this.nextId(), kind: 'assistant', text: e.text });
      else
        this.items.push({
          id: this.nextId(),
          kind: 'tool',
          toolCallId: this.nextId(),
          title: e.text,
          toolKind: 'other',
          status: 'completed',
        });
    }
    if (entries.length) this.hasContent = true;
    if (this.items.length === 0) return;
    this.setStatusQuiet('stopped', 'Session loaded — agent starts on your next message');
  }

  private setStatusQuiet(status: ChatStatus, text?: string): void {
    this.status = status;
    this.statusText = text;
  }

  // -------------------------------------------------------------------- state ---

  get isLive(): boolean {
    return !!this.pooled && !this.pooled.proc.closed && !!this.sessionId;
  }

  get isBusy(): boolean {
    return this.status === 'running' || this.status === 'starting';
  }

  /** Session id to persist/resume (known once the agent assigned one). */
  get persistentSessionId(): string | undefined {
    return this.sessionId ?? this.resumeId;
  }

  info(): ChatInfo {
    return {
      id: this.id,
      title: this.title,
      status: this.status,
      statusText: this.statusText,
      model: this.model,
      agent: this.agent,
      cwd: this.cwd,
      autoApprove: this.autoApprove,
      pendingChanges: this.svc.changes.count(this.id),
      sessionId: this.persistentSessionId,
    };
  }

  snapshot(): ChatSnapshot {
    return { info: this.info(), items: this.items, models: this.models };
  }

  private setStatus(status: ChatStatus, text?: string): void {
    this.status = status;
    this.statusText = text;
    this.events.info(this);
  }

  refreshInfo(): void {
    this.events.info(this);
  }

  // -------------------------------------------------------------- transcript ops ---

  private nextId(): string {
    return `${this.id}:${++this.itemSeq}`;
  }

  private push<T extends Item>(item: T): T {
    this.items.push(item);
    this.events.item(this, item);
    return item;
  }

  private upsert(item: Item): void {
    this.events.item(this, item);
  }

  addNotice(level: 'info' | 'warn' | 'error', text: string): void {
    this.push({ id: this.nextId(), kind: 'notice', level, text });
  }

  private appendAssistant(text: string): void {
    if (!this.curAssistant) {
      this.curThought = undefined;
      this.curAssistant = this.push({ id: this.nextId(), kind: 'assistant', text });
      return;
    }
    this.curAssistant.text += text;
    this.events.append(this, this.curAssistant.id, text);
  }

  private appendThought(text: string): void {
    if (!this.curThought) {
      this.curAssistant = undefined;
      this.curThought = this.push({ id: this.nextId(), kind: 'thought', text });
      return;
    }
    this.curThought.text += text;
    this.events.append(this, this.curThought.id, text);
  }

  // ---------------------------------------------------------------- lifecycle ---

  /** Make sure an agent process + ACP session exists for this chat. */
  ensureStarted(): Promise<void> {
    if (this.isLive) return Promise.resolve();
    this.starting ??= this.start().finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async start(): Promise<void> {
    this.svc.ensureSlot(this);
    this.setStartStatus('Starting Code Puppy…');
    const pooled = await this.svc.pool.acquire();
    pooled.router.target = this.handlers();
    pooled.proc.on('close', (reason: string) => this.onProcessClosed(pooled, reason));
    this.pooled = pooled;
    const agent = pooled.agent;
    let options: ConfigOption[] | undefined;
    const resume = this.sessionId ?? this.resumeId;
    try {
      if (resume) {
        this.sessionId = resume; // set first: replayed updates are routed by session id
        // If the transcript is already populated (process restarted mid-chat) don't duplicate it.
        const alreadyShown = this.items.length > 0;
        if (alreadyShown) this.suppress++;
        try {
          this.setStartStatus('Loading session…');
          options = (await agent.loadSession(resume, this.cwd, this.additionalDirs)).configOptions;
        } finally {
          if (alreadyShown) this.suppress--;
        }
      } else {
        const res = await agent.newSession(this.cwd, this.additionalDirs);
        this.sessionId = res.sessionId;
        options = res.configOptions;
      }
      this.applyConfigOptions(options);
      await this.applyDesiredModel();
      await this.applyDesiredAgent();
      this.resumeId = undefined;
      if (this.turnActive) this.setStatus('running', 'Thinking…');
      else this.setStatus('idle');
      this.svc.persistMeta(this);
    } catch (e) {
      this.sessionId = undefined;
      pooled.proc.dispose();
      this.pooled = undefined;
      if (!this.turnActive) this.setStatus('error', 'Could not start the agent');
      throw e;
    }
  }

  /** True while a user turn is in flight (including the time spent starting the agent for it). */
  private turnActive = false;

  private setStartStatus(text: string): void {
    // If the user already sent a message, keep showing "running" and just update the detail text.
    if (this.turnActive) this.setStatus('running', text);
    else this.setStatus('starting', text);
  }

  /** The model the agent process is currently using (from its config options). */
  private agentModel?: string;

  private applyConfigOptions(options?: ConfigOption[]): void {
    const model = options?.find((o) => o.category === 'model' || o.id === 'model');
    if (!model) return;
    this.models = model.options.map((o) => ({ id: o.value, name: o.name, description: o.description }));
    this.agentModel = model.currentValue;
  }

  /** Align the process's model with what the user picked (or adopt the process default). */
  private async applyDesiredModel(): Promise<void> {
    const want = this.model;
    const current = this.agentModel;
    if (!want) {
      this.model = current;
    } else if (this.models.length && !this.models.some((m) => m.id === want)) {
      this.addNotice('warn', `Model '${want}' is not available; using '${current}'.`);
      this.model = current;
    } else if (want !== current) {
      const opts = await this.pooled!.agent.setConfigOption(this.sessionId!, 'model', want);
      this.agentModel = want;
      this.applyConfigOptions(opts);
      this.agentModel = want;
    }
    this.events.info(this);
  }

  private async applyDesiredAgent(): Promise<void> {
    const procAgent = this.pooled!.pinnedAgent ?? this.svc.stockDefaultAgent();
    if (this.agent !== procAgent) await this.switchAgentInProcess(this.agent);
  }

  private async switchAgentInProcess(name: string): Promise<void> {
    const agent = this.pooled!.agent;
    this.suppress++;
    this.suppressedText = '';
    try {
      await agent.prompt(this.sessionId!, [{ type: 'text', text: `/agent ${name}` }]);
      // Rebuild the session on the newly selected agent, keeping persisted history.
      await agent.loadSession(this.sessionId!, this.cwd, this.additionalDirs);
    } finally {
      this.suppress--;
    }
    this.svc.log.info(`[chat ${this.id}] switched agent -> ${name}: ${this.suppressedText.replace(/\s+/g, ' ').slice(0, 200)}`);
    if (/not found|unknown|invalid/i.test(this.suppressedText)) this.addNotice('warn', `Agent '${name}' may not exist: ${this.suppressedText.slice(0, 200)}`);
  }

  private onProcessClosed(pooled: PooledAgent, reason: string): void {
    if (this.pooled !== pooled) return;
    this.pooled = undefined;
    const wasBusy = this.isBusy;
    for (const [, p] of this.permissionResolvers) {
      p.item.resolved = 'cancelled';
      this.upsert(p.item);
      p.resolve({ outcome: 'cancelled' });
    }
    this.permissionResolvers.clear();
    if (this.status === 'stopped') return;
    if (wasBusy) {
      this.addNotice('error', `The agent process stopped unexpectedly.\n${reason.split('\n').slice(0, 6).join('\n')}`);
      this.setStatus('error', 'Agent stopped');
    } else {
      this.setStatus('stopped', 'Agent sleeping — resumes on next message');
    }
  }

  /** Stop the agent process (chat stays; it transparently resumes on next send). */
  stopProcess(reason = 'Agent sleeping — resumes on next message'): void {
    const p = this.pooled;
    if (!p) return;
    this.status = 'stopped';
    this.statusText = reason;
    this.pooled = undefined;
    for (const [, r] of this.permissionResolvers) r.resolve({ outcome: 'cancelled' });
    this.permissionResolvers.clear();
    p.proc.dispose();
    this.events.info(this);
  }

  dispose(): void {
    this.stopProcess();
  }

  // ----------------------------------------------------------------- user actions ---

  async send(text: string, attachmentIds: string[]): Promise<void> {
    if (this.status === 'running') return;
    const trimmed = text.trim();
    if (!trimmed && attachmentIds.length === 0) return;
    this.lastActive = Date.now();
    this.hasContent = true;
    const { blocks, views } = await this.svc.context.blocksFor(trimmed, attachmentIds);
    this.push({ id: this.nextId(), kind: 'user', text: trimmed, attachments: views.length ? views : undefined });
    if (!this.titleLocked) {
      this.title = trimmed.replace(/\s+/g, ' ').slice(0, 60) || this.title;
      this.titleLocked = true;
    }
    this.curAssistant = undefined;
    this.curThought = undefined;
    this.turnActive = true;
    this.setStatus('running', this.isLive ? 'Thinking…' : 'Starting Code Puppy…');
    try {
      await this.ensureStarted();
      this.setStatus('running', 'Thinking…');
      const res = await this.pooled!.agent.prompt(this.sessionId!, blocks);
      if (res.stopReason === 'cancelled') this.addNotice('info', 'Stopped.');
      else if (res.stopReason === 'refusal') this.addNotice('warn', 'The agent run failed or was refused. See the Builder log for details.');
      this.setStatus('idle');
    } catch (e) {
      this.svc.log.error(`[chat ${this.id}] send failed`, e);
      this.addNotice('error', (e as Error).message);
      this.setStatus('error', 'Error');
    } finally {
      this.turnActive = false;
      this.finishOpenTools();
      this.curAssistant = undefined;
      this.curThought = undefined;
      this.lastActive = Date.now();
      this.svc.context.forget(attachmentIds);
      this.svc.persistMeta(this);
      this.events.info(this);
    }
  }

  cancel(): void {
    if (this.pooled && this.sessionId && this.status === 'running') {
      this.pooled.agent.cancel(this.sessionId);
      for (const [, r] of this.permissionResolvers) r.resolve({ outcome: 'cancelled' });
      for (const [, r] of this.permissionResolvers) {
        r.item.resolved = 'cancelled';
        this.upsert(r.item);
      }
      this.permissionResolvers.clear();
      this.statusText = 'Stopping…';
      this.events.info(this);
    }
  }

  async setModel(id: string): Promise<void> {
    this.model = id;
    if (this.isLive) {
      try {
        const opts = await this.pooled!.agent.setConfigOption(this.sessionId!, 'model', id);
        this.applyConfigOptions(opts);
        this.agentModel = id;
      } catch (e) {
        this.addNotice('error', `Could not switch model: ${(e as Error).message}`);
      }
    }
    this.events.info(this);
  }

  setAutoApprove(v: boolean): void {
    this.autoApprove = v;
    this.events.info(this);
  }

  resolvePermission(requestId: string, optionId: string): void {
    const r = this.permissionResolvers.get(requestId);
    if (!r) return;
    this.permissionResolvers.delete(requestId);
    r.item.resolved = r.options.find((o) => o.optionId === optionId)?.name ?? optionId;
    this.upsert(r.item);
    r.resolve({ outcome: 'selected', optionId });
  }

  // -------------------------------------------------------- agent -> client side ---

  private handlers(): ClientHandlers {
    return {
      onUpdate: (sid, u) => this.onUpdate(sid, u),
      requestPermission: (req) => this.requestPermission(req),
      readTextFile: async (p) => ({ content: await this.svc.changes.readText(p.path, p.line, p.limit) }),
      writeTextFile: (p) => this.writeTextFile(p.path, p.content),
      terminal: settings.delegateTerminal ? this.svc.terminals.asHandlers() : undefined,
    };
  }

  private async writeTextFile(p: string, content: string): Promise<void> {
    if (!(await this.allowWritePath(p))) throw new Error(`Write to ${p} was denied (outside the workspace).`);
    await this.svc.changes.applyWrite(this.id, p, content);
    this.events.info(this);
  }

  private isInsideWorkspace(p: string): boolean {
    const roots = [this.cwd, ...this.additionalDirs, ...(vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [])];
    const abs = path.resolve(p);
    return roots.some((r) => {
      const rel = path.relative(path.resolve(r), abs);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
  }

  /** Safety rail: writes outside the workspace need explicit confirmation (even in auto-approve). */
  private async allowWritePath(p: string): Promise<boolean> {
    if (this.isInsideWorkspace(p) || this.outsideWorkspaceAllowed) return true;
    const pick = await vscode.window.showWarningMessage(
      `The agent wants to write a file outside your workspace:\n${p}`,
      { modal: true },
      'Allow this time',
      'Allow for this chat',
    );
    if (pick === 'Allow for this chat') this.outsideWorkspaceAllowed = true;
    return !!pick;
  }

  private async requestPermission(req: PermissionRequest): Promise<PermissionOutcome> {
    const allow = req.options.find((o) => o.kind === 'allow_once') ?? req.options.find((o) => o.kind.startsWith('allow'));
    const title = req.toolCall?.title ?? 'The agent is asking for permission';
    if (this.autoApprove && allow) {
      this.svc.log.info(`[chat ${this.id}] auto-approved: ${title}`);
      return { outcome: 'selected', optionId: allow.optionId };
    }
    const requestId = uid('perm');
    const item: Extract<Item, { kind: 'permission' }> = {
      id: this.nextId(),
      kind: 'permission',
      requestId,
      title,
      options: req.options.map((o) => ({ id: o.optionId, name: o.name, kind: o.kind })),
    };
    this.push(item);
    this.statusText = 'Waiting for your approval…';
    this.events.info(this);
    if (!this.svc.isChatVisible()) {
      void vscode.window.showInformationMessage(`Builder needs approval: ${title}`, 'Open chat').then((c) => {
        if (c) this.svc.revealChat();
      });
    }
    return new Promise<PermissionOutcome>((resolve) => {
      this.permissionResolvers.set(requestId, { resolve, item, options: req.options });
    }).finally(() => {
      if (this.status === 'running') {
        this.statusText = 'Working…';
        this.events.info(this);
      }
    });
  }

  private onUpdate(sessionId: string, u: SessionUpdate): void {
    if (sessionId !== this.sessionId) return;
    if (this.suppress > 0) {
      if (u.sessionUpdate === 'agent_message_chunk') this.suppressedText += (u as any).content?.text ?? '';
      return;
    }
    switch (u.sessionUpdate) {
      case 'user_message_chunk': {
        const text = cleanReplayedUserText((u as any).content?.text ?? '');
        if (text) {
          this.curAssistant = undefined;
          this.curThought = undefined;
          this.hasContent = true;
          this.push({ id: this.nextId(), kind: 'user', text });
          if (!this.titleLocked) {
            this.title = text.replace(/\s+/g, ' ').slice(0, 60);
            this.titleLocked = true;
          }
        }
        break;
      }
      case 'agent_message_chunk': {
        const text = (u as any).content?.text;
        if (text) {
          if (this.status === 'running') {
            this.statusText = 'Responding…';
          }
          this.appendAssistant(text);
        }
        break;
      }
      case 'agent_thought_chunk': {
        const text = (u as any).content?.text;
        if (text) this.appendThought(text);
        break;
      }
      case 'tool_call': {
        const t = u as Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>;
        this.curAssistant = undefined;
        this.curThought = undefined;
        const loc = t.locations?.[0];
        const item = this.push<Extract<Item, { kind: 'tool' }>>({
          id: this.nextId(),
          kind: 'tool',
          toolCallId: t.toolCallId,
          title: t.title,
          toolKind: t.kind ?? 'other',
          status: t.status ?? 'in_progress',
          detail: describeRawInput(t.kind, t.rawInput),
          path: loc?.path,
          line: loc?.line,
        });
        this.tools.set(t.toolCallId, item);
        if (this.status === 'running') {
          this.statusText = t.title;
          this.events.info(this);
        }
        break;
      }
      case 'tool_call_update': {
        const t = u as Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>;
        const item = this.tools.get(t.toolCallId);
        if (!item) break;
        if (t.title) item.title = t.title;
        if (t.status) item.status = t.status;
        const { text, diff } = extractContent(t.content);
        if (diff) item.diff = diff;
        const output = text || describeRawOutput(t.rawOutput);
        if (output) item.detail = [item.detail, output].filter(Boolean).join('\n').slice(0, MAX_DETAIL);
        if (item.status === 'completed' || item.status === 'failed') this.tools.delete(t.toolCallId);
        this.upsert(item);
        break;
      }
      case 'config_option_update': {
        const keep = this.agentModel;
        this.applyConfigOptions((u as any).configOptions);
        this.agentModel = keep ?? this.agentModel;
        this.events.info(this);
        break;
      }
      default:
        break;
    }
  }

  private finishOpenTools(): void {
    for (const [, item] of this.tools) {
      if (item.status === 'in_progress' || item.status === 'pending') {
        item.status = 'failed';
        this.upsert(item);
      }
    }
    this.tools.clear();
  }
}

// ------------------------------------------------------------------- helpers ---

export const cleanReplayedUserText = stripBuilderContext;

function describeRawInput(kind: string | undefined, raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (kind === 'execute' && typeof r.command === 'string') return `$ ${r.command}`;
  if (typeof r.search_string === 'string') return `search: ${r.search_string}`;
  return undefined;
}

function describeRawOutput(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'string') return raw.slice(0, MAX_DETAIL);
  if (typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of ['stdout', 'stderr', 'output', 'message', 'error']) {
      const v = r[k];
      if (typeof v === 'string' && v.trim()) parts.push(k === 'stderr' || k === 'error' ? `[${k}] ${v}` : v);
    }
    if (parts.length) return parts.join('\n').slice(0, MAX_DETAIL);
    if (r.success === true && !('diff' in r)) return undefined;
  }
  return undefined;
}

function extractContent(content?: ToolCallContent[]): { text?: string; diff?: string } {
  let text = '';
  let diff: string | undefined;
  for (const c of content ?? []) {
    if (c.type === 'content' && c.content?.type === 'text') {
      const m = /^```diff\n([\s\S]*?)\n```$/.exec(c.content.text.trim());
      if (m) diff = m[1];
      else text += c.content.text;
    } else if (c.type === 'diff' && c.path) {
      diff = `--- ${c.path}\n+++ ${c.path}\n(new content: ${(c.newText ?? '').length} chars)`;
    }
  }
  return { text: text || undefined, diff };
}
