/**
 * Typed façade over one ACP agent process: handshake, sessions, prompts, and the
 * client-side services the agent calls back into (permissions, fs, terminal).
 * Has no dependency on `vscode`, so it is shared by the extension, tests and the
 * integration script.
 */
import { AcpProcess, AcpRpcError, JsonRpcPeer, Transport, TransportOptions } from './rpc';
import type {
  ClientHandlers,
  ConfigOption,
  ContentBlock,
  NewSessionResult,
  PermissionRequest,
  PromptResult,
  SessionUpdate,
} from './types';

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: Record<string, any>;
  agentInfo?: { name: string; title?: string; version?: string };
}

export class AcpAgent {
  info?: InitializeResult;

  constructor(public readonly transport: Transport, private readonly handlers: ClientHandlers) {
    transport.setRequestHandler((method, params) => this.handleAgentRequest(method, params));
    transport.onNotification((method, params) => {
      if (method === 'session/update') {
        this.handlers.onUpdate(params.sessionId, params.update as SessionUpdate);
      }
    });
  }

  /** Spawn an agent subprocess and wrap it. */
  static spawn(opts: TransportOptions, handlers: ClientHandlers): { agent: AcpAgent; proc: AcpProcess } {
    const proc = new AcpProcess(opts);
    return { agent: new AcpAgent(proc, handlers), proc };
  }

  static overPeer(peer: JsonRpcPeer, handlers: ClientHandlers): AcpAgent {
    return new AcpAgent(peer, handlers);
  }

  private clientCapabilities() {
    return {
      fs: { readTextFile: !!this.handlers.readTextFile, writeTextFile: !!this.handlers.writeTextFile },
      terminal: !!this.handlers.terminal,
    };
  }

  async initialize(timeoutMs = 180_000): Promise<InitializeResult> {
    this.info = await this.transport.request<InitializeResult>(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: this.clientCapabilities(),
        clientInfo: { name: 'builder-vscode', title: 'Builder for VS Code', version: '0.1.0' },
      },
      { timeoutMs },
    );
    return this.info;
  }

  newSession(cwd: string, additionalDirectories: string[] = []): Promise<NewSessionResult> {
    const params: any = { cwd, mcpServers: [] };
    if (additionalDirectories.length) params.additionalDirectories = additionalDirectories;
    return this.transport.request<NewSessionResult>('session/new', params, { timeoutMs: 120_000 });
  }

  /** Re-open a persisted session; history is replayed as `session/update`s before this resolves. */
  loadSession(sessionId: string, cwd: string, additionalDirectories: string[] = []): Promise<{ configOptions?: ConfigOption[] }> {
    const params: any = { sessionId, cwd, mcpServers: [] };
    if (additionalDirectories.length) params.additionalDirectories = additionalDirectories;
    return this.transport.request('session/load', params, { timeoutMs: 120_000 });
  }

  prompt(sessionId: string, prompt: ContentBlock[]): Promise<PromptResult> {
    return this.transport.request<PromptResult>('session/prompt', { sessionId, prompt });
  }

  cancel(sessionId: string): void {
    this.transport.notify('session/cancel', { sessionId });
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<ConfigOption[] | undefined> {
    const res = await this.transport.request<{ configOptions?: ConfigOption[] }>('session/set_config_option', {
      sessionId,
      configId,
      value,
    });
    return res?.configOptions;
  }

  async closeSession(sessionId: string): Promise<void> {
    try {
      await this.transport.request('session/close', { sessionId }, { timeoutMs: 15_000 });
    } catch {
      /* best effort */
    }
  }

  dispose(): void {
    this.transport.dispose();
  }

  // ---- agent -> client requests ------------------------------------------------
  private async handleAgentRequest(method: string, p: any): Promise<unknown> {
    const h = this.handlers;
    switch (method) {
      case 'session/request_permission':
        return { outcome: await h.requestPermission(p as PermissionRequest) };
      case 'fs/read_text_file':
        if (!h.readTextFile) break;
        return h.readTextFile(p);
      case 'fs/write_text_file':
        if (!h.writeTextFile) break;
        await h.writeTextFile(p);
        return {};
      case 'terminal/create':
        if (!h.terminal) break;
        return h.terminal.create(p);
      case 'terminal/output':
        if (!h.terminal) break;
        return h.terminal.output(p);
      case 'terminal/wait_for_exit':
        if (!h.terminal) break;
        return h.terminal.waitForExit(p);
      case 'terminal/kill':
        if (!h.terminal) break;
        await h.terminal.kill(p);
        return {};
      case 'terminal/release':
        if (!h.terminal) break;
        await h.terminal.release(p);
        return {};
    }
    throw new AcpRpcError(-32601, `Method not found: ${method}`);
  }
}
