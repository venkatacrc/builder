import * as vscode from 'vscode';

export class Logger {
  private channel = vscode.window.createOutputChannel('Builder');

  info(msg: string): void {
    this.channel.appendLine(`${new Date().toISOString()} ${msg}`);
  }

  error(msg: string, err?: unknown): void {
    const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : err ? String(err) : '';
    this.channel.appendLine(`${new Date().toISOString()} ERROR ${msg} ${detail}`);
  }

  /** Returns a line logger tagged with a source label (one per agent process). */
  tagged(tag: string): (line: string) => void {
    return (line) => this.info(`[${tag}] ${line}`);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}

export function uid(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
