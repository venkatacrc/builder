import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { AcpAgent } from '../acp/agent';
import { AcpProcess } from '../acp/rpc';
import type { ClientHandlers, PermissionOutcome, PermissionRequest, SessionUpdate, TerminalCreateParams } from '../acp/types';
import { settings } from '../config';
import { Catalog, FALLBACK_AGENTS, PuppyInstall, locateCodePuppy, readUserModels } from '../puppy/files';
import { Logger } from '../util/log';
import { getShellEnv } from '../util/shellEnv';

export const UNTRUSTED_MESSAGE = 'This folder is in Restricted Mode. Trust it to start Code Puppy.';

/** Forwards agent->client calls to whichever chat currently owns the process. */
export class HandlerRouter implements ClientHandlers {
  target?: ClientHandlers;
  readonly terminal?: ClientHandlers['terminal'];

  constructor(delegateTerminal: boolean) {
    if (delegateTerminal) {
      const t = () => {
        if (!this.target?.terminal) throw new Error('no terminal handler');
        return this.target.terminal;
      };
      this.terminal = {
        create: (p: TerminalCreateParams) => t().create(p),
        output: (p) => t().output(p),
        waitForExit: (p) => t().waitForExit(p),
        kill: (p) => t().kill(p),
        release: (p) => t().release(p),
      };
    }
  }

  onUpdate(sessionId: string, update: SessionUpdate): void {
    this.target?.onUpdate(sessionId, update);
  }
  async requestPermission(req: PermissionRequest): Promise<PermissionOutcome> {
    if (!this.target) return { outcome: 'cancelled' };
    return this.target.requestPermission(req);
  }
  async readTextFile(p: { sessionId: string; path: string; line?: number; limit?: number }) {
    if (!this.target?.readTextFile) throw new Error('no fs handler');
    return this.target.readTextFile(p);
  }
  async writeTextFile(p: { sessionId: string; path: string; content: string }) {
    if (!this.target?.writeTextFile) throw new Error('no fs handler');
    return this.target.writeTextFile(p);
  }
}

export interface PooledAgent {
  agent: AcpAgent;
  proc: AcpProcess;
  router: HandlerRouter;
  startupMs: number;
  /** Agent the launcher pinned at startup (undefined when running stock `code-puppy --acp`). */
  pinnedAgent?: string;
}

export class AgentRuntime {
  private installPromise?: Promise<PuppyInstall | undefined>;
  private catalogPromise?: Promise<Catalog>;

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly log: Logger) {}

  resetInstallCache(): void {
    this.installPromise = undefined;
  }

  install(): Promise<PuppyInstall | undefined> {
    this.installPromise ??= getShellEnv().then((env) => locateCodePuppy(settings.codePuppyPath || undefined, env));
    return this.installPromise;
  }

  private launcherPath(): string {
    return path.join(this.ctx.extensionPath, 'dist', 'python', 'builder_launcher.py');
  }

  /** Spawns an `--acp` process and returns it, *not yet* initialized. */
  async spawnProcess(opts: {
    tag: string;
    handlers: ClientHandlers;
    utility?: boolean;
    cwd?: string;
  }): Promise<{ agent: AcpAgent; proc: AcpProcess; pinnedAgent?: string }> {
    if (!vscode.workspace.isTrusted) throw new Error(UNTRUSTED_MESSAGE);
    const install = await this.install();
    if (!install) {
      throw new Error(
        'Could not find the `code-puppy` executable. Install it (curl -skSL https://puppy.walmart.com/api/releases/setup_v2 | bash) or set "builder.codePuppyPath".',
      );
    }
    const env = { ...(await getShellEnv()) } as NodeJS.ProcessEnv;
    env.PYTHONUNBUFFERED = '1';
    env.BUILDER_PERSIST_MODEL = settings.persistModelSelection ? '1' : '0';
    env.BUILDER_AGENT = settings.agent;
    if (opts.utility) env.BUILDER_UTILITY = '1';
    const extra = opts.utility ? ['--no-tools'] : [];

    let command = install.executable;
    let args = ['--acp', ...extra];
    let pinnedAgent: string | undefined;
    if (settings.useLauncher && install.python && fs.existsSync(this.launcherPath())) {
      command = install.python;
      args = [this.launcherPath(), '--acp', ...extra];
      pinnedAgent = env.BUILDER_AGENT;
    }
    const cwd = opts.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    this.log.info(`[${opts.tag}] spawn: ${command} ${args.join(' ')}`);
    const { agent, proc } = AcpAgent.spawn(
      { command, args, cwd, env, log: this.log.tagged(opts.tag), traceProtocol: settings.logProtocol },
      opts.handlers,
    );
    return { agent, proc, pinnedAgent };
  }

  async spawnPooled(tag: string): Promise<PooledAgent> {
    const router = new HandlerRouter(settings.delegateTerminal);
    const t0 = Date.now();
    const { agent, proc, pinnedAgent } = await this.spawnProcess({ tag, handlers: router });
    try {
      await agent.initialize();
    } catch (e) {
      proc.dispose();
      throw e;
    }
    const startupMs = Date.now() - t0;
    this.log.info(`[${tag}] ready in ${(startupMs / 1000).toFixed(1)}s (pid ${proc.pid}, ${agent.info?.agentInfo?.title} ${agent.info?.agentInfo?.version})`);
    return { agent, proc, router, startupMs, pinnedAgent };
  }

  // ------------------------------------------------------------------ catalog ---

  /** Agents + models. Served from cache immediately; refreshed in the background. */
  async catalog(): Promise<Catalog> {
    const cached = this.ctx.globalState.get<Catalog>('builder.catalog');
    if (!this.catalogPromise) this.catalogPromise = this.refreshCatalog();
    if (cached) return cached;
    return this.fallbackCatalog();
  }

  /** Resolves when the (possibly slow) background refresh is done. */
  async refreshedCatalog(): Promise<Catalog> {
    this.catalogPromise ??= this.refreshCatalog();
    return this.catalogPromise;
  }

  private fallbackCatalog(): Catalog {
    return {
      agents: { ...FALLBACK_AGENTS },
      models: readUserModels(settings.configDir).map((m) => m.id),
      defaultAgent: 'code-puppy',
      defaultModel: null,
    };
  }

  private async refreshCatalog(): Promise<Catalog> {
    const fallback = this.fallbackCatalog();
    if (!vscode.workspace.isTrusted) return this.ctx.globalState.get<Catalog>('builder.catalog') ?? fallback;
    try {
      const install = await this.install();
      if (!install?.python) return this.cacheAndReturn(fallback);
      const script = path.join(this.ctx.extensionPath, 'dist', 'python', 'builder_catalog.py');
      const env = await getShellEnv();
      const out = await new Promise<string>((resolve, reject) => {
        execFile(install.python!, [script], { env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
      });
      const lines = out.trim().split('\n');
      const parsed = JSON.parse(lines[lines.length - 1]) as Catalog & { agentsError?: string };
      if (parsed.agentsError) this.log.info(`catalog: agent discovery error: ${parsed.agentsError}`);
      if (!Object.keys(parsed.agents ?? {}).length) parsed.agents = fallback.agents;
      if (!parsed.models?.length) parsed.models = fallback.models;
      return this.cacheAndReturn(parsed);
    } catch (e) {
      this.log.error('catalog refresh failed', e);
      return this.cacheAndReturn(this.ctx.globalState.get<Catalog>('builder.catalog') ?? fallback);
    }
  }

  private async cacheAndReturn(c: Catalog): Promise<Catalog> {
    await this.ctx.globalState.update('builder.catalog', c);
    return c;
  }

  invalidateCatalog(): void {
    this.catalogPromise = undefined;
    void this.catalog();
  }
}

/** Keeps one initialized-but-unclaimed agent process around so new chats start instantly. */
export class AgentPool {
  private spare?: Promise<PooledAgent>;
  private counter = 0;
  private disposed = false;
  private spareTimer?: NodeJS.Timeout;

  constructor(private readonly runtime: AgentRuntime, private readonly log: Logger) {}

  prewarm(): void {
    if (this.disposed || !settings.prewarm || this.spare || !vscode.workspace.isTrusted) return;
    const tag = `agent#${++this.counter}`;
    const p = this.runtime.spawnPooled(tag);
    this.spare = p;
    // Don't hold a ~300 MB process forever if the chat isn't used: reap an unclaimed spare after 20 min.
    if (this.spareTimer) clearTimeout(this.spareTimer);
    this.spareTimer = setTimeout(() => {
      if (this.spare === p) {
        this.spare = undefined;
        void p.then((x) => x.proc.dispose()).catch(() => {});
      }
    }, 20 * 60_000);
    this.spareTimer.unref?.();
    p.catch((e) => {
      this.log.error(`prewarm ${tag} failed`, e);
      if (this.spare === p) this.spare = undefined;
    });
  }

  /** Take the warm spare (or spawn a fresh one) and schedule a replacement spare. */
  async acquire(): Promise<PooledAgent> {
    let pooled: PooledAgent | undefined;
    if (this.spare) {
      const p = this.spare;
      this.spare = undefined;
      try {
        pooled = await p;
        if (pooled.proc.closed) pooled = undefined;
      } catch {
        pooled = undefined;
      }
    }
    pooled ??= await this.runtime.spawnPooled(`agent#${++this.counter}`);
    // Replace the spare shortly after, so the claim itself is never slowed down.
    setTimeout(() => this.prewarm(), 1500).unref?.();
    return pooled;
  }

  async reset(): Promise<void> {
    await this.dispose();
    this.disposed = false;
    this.prewarm();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.spareTimer) clearTimeout(this.spareTimer);
    const p = this.spare;
    this.spare = undefined;
    if (p) {
      try {
        (await p).proc.dispose();
      } catch {
        /* ignore */
      }
    }
  }
}
