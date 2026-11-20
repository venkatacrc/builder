import * as vscode from 'vscode';
import type { UtilityAgent } from '../agent/UtilityAgent';
import type { Logger } from '../util/log';
import { settings } from '../config';
import { buildCompletionPrompt, cleanCompletion } from './text';

export class TabCompletionProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
  private seq = 0;
  private cache = new Map<string, string>();
  private status: vscode.StatusBarItem;
  private reg: vscode.Disposable;
  private enabledHandle: vscode.Disposable;

  constructor(private readonly utility: UtilityAgent, private readonly log: Logger) {
    this.reg = vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, this);
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.status.command = 'builder.toggleTabCompletion';
    this.enabledHandle = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('builder.tabCompletion')) this.refreshStatus();
    });
    this.refreshStatus();
  }

  refreshStatus(busy = false): void {
    const on = settings.tabEnabled;
    this.status.text = `${busy ? '$(sync~spin)' : '$(sparkle)'} Tab ${on ? 'on' : 'off'}`;
    this.status.tooltip = `Builder Tab autocomplete is ${on ? 'ON' : 'OFF'} (click to toggle)\nModel: ${settings.tabModel || 'Code Puppy default (set builder.tabCompletion.model to a fast model)'}`;
    this.status.show();
    if (on) this.utility.warmUp();
  }

  async provideInlineCompletionItems(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    _ctx: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (!settings.tabEnabled) return undefined;
    if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') return undefined;
    if (doc.lineCount > 20000) return undefined;

    const my = ++this.seq;
    await new Promise((r) => setTimeout(r, settings.tabDebounceMs));
    if (token.isCancellationRequested || my !== this.seq) return undefined;

    const offset = doc.offsetAt(pos);
    const text = doc.getText();
    const prefix = text.slice(Math.max(0, offset - settings.tabMaxPrefix), offset);
    const suffix = text.slice(offset, offset + settings.tabMaxSuffix);
    if (!prefix.trim() && !suffix.trim()) return undefined;

    const key = `${doc.uri.toString()}\u0000${prefix.slice(-400)}\u0000${suffix.slice(0, 200)}`;
    let completion = this.cache.get(key);
    if (completion === undefined) {
      this.refreshStatus(true);
      try {
        const answer = await this.utility.run(
          buildCompletionPrompt({ rel: vscode.workspace.asRelativePath(doc.uri, false), lang: doc.languageId, prefix, suffix }),
          { token },
        );
        completion = cleanCompletion(answer, prefix, suffix);
        if (!token.isCancellationRequested) {
          this.cache.set(key, completion);
          if (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value as string);
        }
      } catch (e) {
        this.log.error('tab completion failed', e);
        return undefined;
      } finally {
        this.refreshStatus(false);
      }
    }
    if (token.isCancellationRequested || my !== this.seq || !completion) return undefined;
    return [new vscode.InlineCompletionItem(completion, new vscode.Range(pos, pos))];
  }

  dispose(): void {
    this.reg.dispose();
    this.status.dispose();
    this.enabledHandle.dispose();
  }
}
