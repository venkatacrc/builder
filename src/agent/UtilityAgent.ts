import * as vscode from 'vscode';
import * as os from 'node:os';
import { AcpAgent } from '../acp/agent';
import { AcpProcess } from '../acp/rpc';
import type { ClientHandlers, SessionUpdate } from '../acp/types';
import { settings } from '../config';
import { deleteBuilderSession } from '../puppy/files';
import { Logger } from '../util/log';
import type { AgentRuntime } from './runtime';

/**
 * A long-lived, tool-less Code Puppy process for one-shot text tasks (Tab completion, inline edit).
 *
 *  - launched with `--no-tools` + `BUILDER_UTILITY=1` (tiny system prompt, no tool schemas)
 *  - never advertises fs/terminal and rejects every permission request: it cannot touch your files
 *  - one throw-away ACP session per request, so there is no history to grow or leak
 */
export class UtilityAgent implements vscode.Disposable {
  private starting?: Promise<{ agent: AcpAgent; proc: AcpProcess }>;
  private collectors = new Map<string, (text: string) => void>();
  private appliedModel?: string;
  private lastUse = Date.now();
  private reaper?: NodeJS.Timeout;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly log: Logger,
    private readonly tag: string,
    private readonly getModel: () => string,
    private readonly idleMinutes = 10,
  ) {}

  private handlers(): ClientHandlers {
    return {
      onUpdate: (sid: string, u: SessionUpdate) => {
        if (u.sessionUpdate === 'agent_message_chunk') {
          const text = (u as any).content?.text;
          if (text) this.collectors.get(sid)?.(text);
        }
      },
      requestPermission: async () => ({ outcome: 'cancelled' }),
    };
  }

  private async ensure(): Promise<{ agent: AcpAgent; proc: AcpProcess }> {
    if (this.starting) {
      try {
        const s = await this.starting;
        if (!s.proc.closed) return s;
      } catch {
        /* restart below */
      }
      this.starting = undefined;
    }
    this.starting = (async () => {
      const { agent, proc } = await this.runtime.spawnProcess({ tag: this.tag, handlers: this.handlers(), utility: true });
      try {
        await agent.initialize();
      } catch (e) {
        proc.dispose();
        throw e;
      }
      this.appliedModel = undefined;
      this.log.info(`[${this.tag}] utility agent ready (pid ${proc.pid})`);
      this.reaper ??= setInterval(() => this.reapIfIdle(), 60_000);
      this.reaper.unref?.();
      return { agent, proc };
    })();
    this.starting.catch(() => (this.starting = undefined));
    return this.starting;
  }

  /** Start the process in the background so the first real request is fast. */
  warmUp(): void {
    void this.ensure().catch((e) => this.log.error(`[${this.tag}] warm-up failed`, e));
  }

  async run(prompt: string, opts: { token?: vscode.CancellationToken; cwd?: string } = {}): Promise<string> {
    this.lastUse = Date.now();
    const { agent } = await this.ensure();
    if (opts.token?.isCancellationRequested) return '';
    const session = await agent.newSession(opts.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir());
    const sid = session.sessionId;
    const chunks: string[] = [];
    this.collectors.set(sid, (t) => chunks.push(t));
    const sub = opts.token?.onCancellationRequested(() => agent.cancel(sid));
    try {
      const want = this.getModel();
      const modelOpt = session.configOptions?.find((o) => o.category === 'model' || o.id === 'model');
      const current = modelOpt?.currentValue;
      if (want && modelOpt && (this.appliedModel !== want || current !== want) && modelOpt.options.some((o) => o.value === want)) {
        if (current !== want) await agent.setConfigOption(sid, 'model', want);
        this.appliedModel = want;
      }
      if (opts.token?.isCancellationRequested) return '';
      const res = await agent.prompt(sid, [{ type: 'text', text: prompt }]);
      if (res.stopReason === 'cancelled') return '';
      return chunks.join('');
    } finally {
      sub?.dispose();
      this.collectors.delete(sid);
      void agent
        .closeSession(sid)
        .catch(() => {})
        .finally(() => deleteBuilderSession(settings.configDir, sid));
      this.lastUse = Date.now();
    }
  }

  private reapIfIdle(): void {
    if (!this.idleMinutes || Date.now() - this.lastUse < this.idleMinutes * 60_000 || this.collectors.size) return;
    this.stop();
  }

  stop(): void {
    const s = this.starting;
    this.starting = undefined;
    if (s) void s.then((x) => x.proc.dispose()).catch(() => {});
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = undefined;
  }

  dispose(): void {
    this.stop();
  }
}
