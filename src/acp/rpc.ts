/**
 * Minimal, dependency-free Agent Client Protocol (ACP) client over stdio.
 *
 * ACP is JSON-RPC 2.0, one JSON object per line. We implement just what a code
 * editor needs: requests, notifications, and handling requests that the agent sends
 * back to us (fs/*, terminal/*, session/request_permission).
 *
 * Gotcha handled here: `code-puppy` writes terminal-theme escape sequences (OSC) to
 * stdout *without a trailing newline* right before the first JSON line, so we strip
 * ANSI/OSC sequences and then locate the first `{`.
 */
import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export type JsonRpcId = number | string;

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class AcpRpcError extends Error {
  constructor(public readonly code: number, message: string, public readonly data?: unknown) {
    super(message);
    this.name = 'AcpRpcError';
  }
}

export type RequestHandler = (method: string, params: any) => Promise<unknown> | unknown;
export type NotificationHandler = (method: string, params: any) => void;

// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Strip terminal escape sequences and return the JSON object text in a line, if any. */
export function extractJsonLine(line: string): string | undefined {
  const cleaned = line.replace(OSC_RE, '').replace(CSI_RE, '');
  const start = cleaned.indexOf('{');
  if (start < 0) return undefined;
  const candidate = cleaned.slice(start).trim();
  return candidate.endsWith('}') ? candidate : undefined;
}

export interface TransportOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Log sink for stderr / protocol traces / non-JSON stdout noise. */
  log?: (line: string) => void;
  traceProtocol?: boolean;
}

export interface Transport {
  request<T = any>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T>;
  notify(method: string, params?: unknown): void;
  setRequestHandler(h: RequestHandler): void;
  onNotification(h: NotificationHandler): void;
  readonly closed: boolean;
  dispose(): void;
}

/** Transport over any pair of line streams (used by tests with a fake agent). */
export class JsonRpcPeer extends EventEmitter implements Transport {
  private nextId = 1;
  private pending = new Map<JsonRpcId, { resolve: (v: any) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout; method: string }>();
  private requestHandler?: RequestHandler;
  private notificationHandlers: NotificationHandler[] = [];
  private buffer = '';
  private _closed = false;

  constructor(
    private readonly write: (line: string) => void,
    private readonly log: (line: string) => void = () => {},
    private readonly trace = false,
  ) {
    super();
  }

  get closed(): boolean {
    return this._closed;
  }

  setRequestHandler(h: RequestHandler): void {
    this.requestHandler = h;
  }

  onNotification(h: NotificationHandler): void {
    this.notificationHandlers.push(h);
  }

  /** Feed raw bytes/text from the agent's stdout. */
  feed(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    const json = extractJsonLine(line);
    if (!json) {
      this.log(`[stdout] ${line.replace(OSC_RE, '').slice(0, 300)}`);
      return;
    }
    let msg: any;
    try {
      msg = JSON.parse(json);
    } catch {
      this.log(`[stdout:unparsed] ${json.slice(0, 300)}`);
      return;
    }
    if (this.trace) this.log(`<- ${json.slice(0, 2000)}`);
    this.dispatch(msg);
  }

  private dispatch(msg: any): void {
    if (msg.method !== undefined) {
      if (msg.id !== undefined) void this.handleIncomingRequest(msg);
      else for (const h of this.notificationHandlers) this.safe(() => h(msg.method, msg.params));
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new AcpRpcError(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
    }
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.log(`[handler error] ${(e as Error).stack ?? e}`);
    }
  }

  private async handleIncomingRequest(msg: any): Promise<void> {
    try {
      if (!this.requestHandler) throw new AcpRpcError(-32601, `Method not found: ${msg.method}`);
      const result = await this.requestHandler(msg.method, msg.params);
      this.send({ jsonrpc: '2.0', id: msg.id, result: result ?? null });
    } catch (e) {
      const anyErr = e as { code?: unknown; message?: string };
      const err =
        e instanceof AcpRpcError
          ? e
          : new AcpRpcError(typeof anyErr?.code === 'number' ? anyErr.code : -32603, anyErr?.message ?? String(e));
      this.send({ jsonrpc: '2.0', id: msg.id, error: { code: err.code, message: err.message, data: err.data } });
    }
  }

  request<T = any>(method: string, params?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    if (this._closed) return Promise.reject(new Error('agent connection closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: any = { resolve, reject, method };
      if (opts.timeoutMs) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP request '${method}' timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      }
      this.pending.set(id, entry);
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this._closed) return;
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(msg: unknown): void {
    const line = JSON.stringify(msg);
    if (this.trace) this.log(`-> ${line.slice(0, 2000)}`);
    this.write(line + '\n');
  }

  /** Mark closed and reject everything in flight. */
  close(reason = 'agent connection closed'): void {
    if (this._closed) return;
    this._closed = true;
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(`${reason} (while waiting for '${p.method}')`));
    }
    this.pending.clear();
    this.emit('close', reason);
  }

  dispose(): void {
    this.close('disposed');
  }
}

/** A spawned `code-puppy --acp` (or any ACP agent) process. */
export class AcpProcess extends JsonRpcPeer {
  readonly child!: ChildProcess;
  private stderrTail!: string[];

  constructor(opts: TransportOptions) {
    const logFn = opts.log ?? (() => {});
    const holder: { child?: ChildProcess } = {};
    super((line) => holder.child?.stdin?.write(line), logFn, !!opts.traceProtocol);
    this.stderrTail = [];
    (this as { child: ChildProcess }).child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    holder.child = this.child;
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (d: string) => this.feed(d));
    this.child.stderr!.setEncoding('utf8');
    this.child.stderr!.on('data', (d: string) => {
      for (const l of d.split('\n')) {
        if (!l.trim()) continue;
        this.stderrTail.push(l);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
        logFn(`[stderr] ${l}`);
      }
    });
    this.child.stdin!.on('error', () => {});
    this.child.on('error', (err) => this.close(`failed to start agent: ${err.message}`));
    this.child.on('exit', (code, signal) => {
      this.close(`agent exited (code=${code}, signal=${signal})\n${this.stderrTail.slice(-8).join('\n')}`);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get stderrSnapshot(): string {
    return this.stderrTail.join('\n');
  }

  override dispose(): void {
    if (!this.closed) {
      try {
        this.child.stdin?.end();
      } catch {
        /* ignore */
      }
    }
    const child = this.child;
    setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    }, 1500).unref();
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 5000).unref();
    super.dispose();
  }
}
