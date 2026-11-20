import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'node:child_process';
import { uid } from '../util/log';
import { getShellEnv } from '../util/shellEnv';
import type { ClientHandlers, TerminalCreateParams } from '../acp/types';

interface Entry {
  id: string;
  child: ChildProcess;
  output: string;
  truncated: boolean;
  limit: number;
  exit?: { exitCode: number | null; signal: string | null };
  exitWaiters: ((e: { exitCode: number | null; signal: string | null }) => void)[];
  terminal: vscode.Terminal;
  writeEmitter: vscode.EventEmitter<string>;
  opened: boolean;
}

/**
 * Implements ACP `terminal/*` so agent shell commands run in visible VS Code terminals.
 * Each command gets its own read-only terminal (a Pseudoterminal that streams the child's output);
 * the same output is returned to the agent via `terminal/output`.
 */
export class TerminalManager implements vscode.Disposable {
  private entries = new Map<string, Entry>();

  asHandlers(): NonNullable<ClientHandlers['terminal']> {
    return {
      create: (p) => this.create(p),
      output: async (p) => this.output(p.terminalId),
      waitForExit: (p) => this.waitForExit(p.terminalId),
      kill: async (p) => this.kill(p.terminalId),
      release: async (p) => this.release(p.terminalId),
    };
  }

  private async create(p: TerminalCreateParams): Promise<{ terminalId: string }> {
    const id = uid('term');
    const env = { ...(await getShellEnv()) } as NodeJS.ProcessEnv;
    for (const e of p.env ?? []) env[e.name] = e.value;
    const writeEmitter = new vscode.EventEmitter<string>();
    const title = `Builder: ${[p.command, ...(p.args ?? [])].join(' ').replace(/^\/bin\/sh -c /, '').slice(0, 48)}`;
    const entry = {
      id,
      output: '',
      truncated: false,
      limit: p.outputByteLimit ?? 1_000_000,
      exitWaiters: [],
      writeEmitter,
      opened: false,
    } as unknown as Entry;

    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      open: () => {
        entry.opened = true;
        if (entry.output) writeEmitter.fire(toCrlf(entry.output));
        if (entry.exit) writeEmitter.fire(exitBanner(entry.exit));
      },
      close: () => {
        if (!entry.exit) entry.child.kill('SIGTERM');
      },
      handleInput: (data) => {
        // Ctrl+C in the terminal interrupts the running command.
        if (data === '\x03' && !entry.exit) entry.child.kill('SIGINT');
      },
    };
    entry.terminal = vscode.window.createTerminal({ name: title, pty });

    entry.child = spawn(p.command, p.args ?? [], { cwd: p.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (d: Buffer) => {
      const text = d.toString('utf8');
      entry.output += text;
      if (entry.output.length > entry.limit) {
        entry.output = entry.output.slice(entry.output.length - entry.limit);
        entry.truncated = true;
      }
      if (entry.opened) writeEmitter.fire(toCrlf(text));
    };
    entry.child.stdout!.on('data', onData);
    entry.child.stderr!.on('data', onData);
    const finish = (exitCode: number | null, signal: string | null) => {
      if (entry.exit) return;
      entry.exit = { exitCode, signal };
      if (entry.opened) writeEmitter.fire(exitBanner(entry.exit));
      for (const w of entry.exitWaiters) w(entry.exit);
      entry.exitWaiters = [];
    };
    entry.child.on('exit', (code, signal) => finish(code, signal));
    entry.child.on('error', (err) => {
      onData(Buffer.from(`\n[failed to start: ${err.message}]\n`));
      finish(127, null);
    });

    this.entries.set(id, entry);
    // Show without stealing focus; the chat remains the primary surface.
    entry.terminal.show(true);
    return { terminalId: id };
  }

  private need(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new Error(`unknown terminal ${id}`);
    return e;
  }

  private output(id: string) {
    const e = this.need(id);
    return { output: e.output, truncated: e.truncated, exitStatus: e.exit };
  }

  private waitForExit(id: string): Promise<{ exitCode: number | null; signal: string | null }> {
    const e = this.need(id);
    if (e.exit) return Promise.resolve(e.exit);
    return new Promise((resolve) => e.exitWaiters.push(resolve));
  }

  private kill(id: string): void {
    const e = this.need(id);
    if (!e.exit) e.child.kill('SIGTERM');
  }

  private release(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    if (!e.exit) e.child.kill('SIGTERM');
    this.entries.delete(id);
    // Tidy up quickly after successful commands; keep failures visible for inspection.
    setTimeout(() => {
      if (e.exit?.exitCode === 0) e.terminal.dispose();
    }, 20_000).unref?.();
  }

  dispose(): void {
    for (const e of this.entries.values()) {
      if (!e.exit) e.child.kill('SIGTERM');
      e.terminal.dispose();
    }
    this.entries.clear();
  }
}

const toCrlf = (s: string) => s.replace(/\r?\n/g, '\r\n');
const exitBanner = (e: { exitCode: number | null; signal: string | null }) =>
  `\r\n\x1b[2m[process exited${e.exitCode !== null ? ` with code ${e.exitCode}` : ''}${e.signal ? ` (${e.signal})` : ''}]\x1b[0m\r\n`;
