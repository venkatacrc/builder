import * as vscode from 'vscode';
import * as path from 'node:path';
import { diffLines } from 'diff';
import { Logger } from '../util/log';
import { trimCommon } from '../inline/text';

export const ORIGINAL_SCHEME = 'builder-original';

export interface ChangeRecord {
  path: string;
  /** Content before the agent's first pending write; null = file did not exist. */
  original: string | null;
  /** Content the agent last wrote (used to detect later manual edits). */
  lastWritten: string;
  chatIds: Set<string>;
  version: number;
  time: number;
}

interface Hunks {
  added: vscode.Range[];
  removed: { line: number; text: string }[];
  firstLine: number;
}

/**
 * Applies agent file writes to the workspace (through VS Code, so open buffers stay in
 * sync) while remembering the pre-edit content so the user can review, keep or undo.
 */
export class ChangeTracker implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider, vscode.Disposable {
  private records = new Map<string, ChangeRecord>();
  private disposables: vscode.Disposable[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires whenever the set of pending changes changes (views, status bar). */
  readonly onDidChangeRecords = this._onDidChange.event;
  private readonly _onDidChangeContent = new vscode.EventEmitter<vscode.Uri>();
  /** TextDocumentContentProvider event (virtual 'original' documents). */
  readonly onDidChange = this._onDidChangeContent.event;
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  private addedDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    gutterIconPath: undefined,
  });
  private removedDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderStyle: 'solid',
    borderWidth: '1px 0 0 0',
    borderColor: new vscode.ThemeColor('editorError.foreground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  constructor(private readonly log: Logger) {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, this),
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshDecorations()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.records.has(e.document.uri.fsPath)) this.refreshDecorations();
      }),
      this.addedDecoration,
      this.removedDecoration,
      this._onDidChange,
      this._onDidChangeContent,
      this._onDidChangeCodeLenses,
    );
  }

  // ------------------------------------------------------------------- queries ---

  all(): ChangeRecord[] {
    return [...this.records.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  get(p: string): ChangeRecord | undefined {
    return this.records.get(p);
  }

  count(chatId?: string): number {
    if (!chatId) return this.records.size;
    let n = 0;
    for (const r of this.records.values()) if (r.chatIds.has(chatId)) n++;
    return n;
  }

  // ------------------------------------------------------- fs services for agents ---

  async readText(p: string, line?: number, limit?: number): Promise<string> {
    const uri = vscode.Uri.file(p);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === uri.fsPath);
    let text: string;
    if (open) text = open.getText();
    else {
      try {
        text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      } catch {
        throw new RpcNotFound(p);
      }
    }
    if (line === undefined && limit === undefined) return text;
    const lines = text.split('\n');
    const start = Math.max(0, (line ?? 1) - 1);
    return lines.slice(start, limit ? start + limit : undefined).join('\n');
  }

  /** Apply an agent write and track it for review. */
  async applyWrite(chatId: string, p: string, content: string): Promise<void> {
    const uri = vscode.Uri.file(p);
    let before: string | null;
    try {
      before = await this.readText(p);
    } catch {
      before = null;
    }
    if (before === content) return; // no-op write

    let rec = this.records.get(p);
    if (!rec) {
      rec = { path: p, original: before, lastWritten: content, chatIds: new Set(), version: 0, time: Date.now() };
      this.records.set(p, rec);
    }
    rec.chatIds.add(chatId);
    rec.lastWritten = content;
    rec.version++;
    rec.time = Date.now();

    await this.writeContent(uri, content);
    this.afterChange(uri);
  }

  private async writeContent(uri: vscode.Uri, content: string): Promise<void> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) {
      const old = open.getText();
      const { start, endOld, endNew } = trimCommon(old, content);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(open.positionAt(start), open.positionAt(endOld)), content.slice(start, endNew));
      await vscode.workspace.applyEdit(edit);
      await open.save();
    } else {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    }
  }

  private afterChange(uri?: vscode.Uri): void {
    if (uri) this._onDidChangeContent.fire(uri);
    this.refreshDecorations();
    this._onDidChangeCodeLenses.fire();
    this._onDidChange.fire();
  }

  // ------------------------------------------------------------------- actions ---

  keep(p: string): void {
    this.records.delete(p);
    this.afterChange(vscode.Uri.file(p));
  }

  async undo(p: string, opts: { confirm?: boolean } = {}): Promise<boolean> {
    const rec = this.records.get(p);
    if (!rec) return false;
    const uri = vscode.Uri.file(p);
    if (opts.confirm !== false) {
      let current: string | undefined;
      try {
        current = await this.readText(p);
      } catch {
        current = undefined;
      }
      if (current !== undefined && current !== rec.lastWritten) {
        const pick = await vscode.window.showWarningMessage(
          `${path.basename(p)} was modified after the agent's edit. Undoing will discard those changes too.`,
          { modal: true },
          'Undo anyway',
        );
        if (pick !== 'Undo anyway') return false;
      }
    }
    try {
      if (rec.original === null) {
        await vscode.workspace.fs.delete(uri, { useTrash: true });
      } else {
        await this.writeContent(uri, rec.original);
      }
    } catch (e) {
      this.log.error(`undo failed for ${p}`, e);
      void vscode.window.showErrorMessage(`Could not undo ${path.basename(p)}: ${(e as Error).message}`);
      return false;
    }
    this.records.delete(p);
    this.afterChange(uri);
    return true;
  }

  keepAll(chatId?: string): void {
    for (const r of this.all()) if (!chatId || r.chatIds.has(chatId)) this.records.delete(r.path);
    this.afterChange();
  }

  async undoAll(chatId?: string): Promise<void> {
    const targets = this.all().filter((r) => !chatId || r.chatIds.has(chatId));
    if (!targets.length) return;
    const pick = await vscode.window.showWarningMessage(
      `Undo agent edits in ${targets.length} file${targets.length === 1 ? '' : 's'}?`,
      { modal: true },
      'Undo all',
    );
    if (pick !== 'Undo all') return;
    for (const r of targets) await this.undo(r.path, { confirm: false });
  }

  async showDiff(p: string): Promise<void> {
    const rec = this.records.get(p);
    if (!rec) {
      await vscode.window.showTextDocument(vscode.Uri.file(p));
      return;
    }
    const left = vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path: p, query: String(rec.version) });
    await vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.file(p), `${path.basename(p)} (Builder: before ↔ after)`, { preview: false });
  }

  async reviewNext(chatId?: string): Promise<void> {
    const list = this.all().filter((r) => !chatId || r.chatIds.has(chatId));
    if (!list.length) {
      void vscode.window.showInformationMessage('No pending Builder changes.');
      return;
    }
    await this.showDiff(list[0].path);
  }

  // ------------------------------------------- content provider (original side) ---

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.records.get(uri.path)?.original ?? '';
  }

  // --------------------------------------------------------- decorations / lenses ---

  private computeHunks(rec: ChangeRecord, current: string): Hunks {
    const parts = diffLines(rec.original ?? '', current);
    const added: vscode.Range[] = [];
    const removed: { line: number; text: string }[] = [];
    let line = 0;
    let firstLine = -1;
    for (const part of parts) {
      const count = part.count ?? part.value.split('\n').length - (part.value.endsWith('\n') ? 1 : 0);
      if (part.added) {
        added.push(new vscode.Range(line, 0, line + count - 1, 0));
        if (firstLine < 0) firstLine = line;
        line += count;
      } else if (part.removed) {
        removed.push({ line, text: part.value });
        if (firstLine < 0) firstLine = line;
      } else {
        line += count;
      }
    }
    return { added, removed, firstLine: Math.max(0, firstLine) };
  }

  refreshDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme !== 'file') continue;
      const rec = this.records.get(editor.document.uri.fsPath);
      if (!rec) {
        editor.setDecorations(this.addedDecoration, []);
        editor.setDecorations(this.removedDecoration, []);
        continue;
      }
      const h = this.computeHunks(rec, editor.document.getText());
      editor.setDecorations(this.addedDecoration, h.added);
      editor.setDecorations(
        this.removedDecoration,
        h.removed.map((r) => {
          const ln = Math.min(r.line, Math.max(0, editor.document.lineCount - 1));
          const md = new vscode.MarkdownString();
          md.appendMarkdown('**Removed by agent**\n');
          md.appendCodeblock(r.text.replace(/\n$/, ''), editor.document.languageId);
          return { range: new vscode.Range(ln, 0, ln, 0), hoverMessage: md };
        }),
      );
    }
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const rec = this.records.get(doc.uri.fsPath);
    if (!rec) return [];
    const line = Math.min(this.computeHunks(rec, doc.getText()).firstLine, Math.max(0, doc.lineCount - 1));
    const range = new vscode.Range(line, 0, line, 0);
    const arg = doc.uri.fsPath;
    return [
      new vscode.CodeLens(range, { title: '$(check) Keep', command: 'builder.keepChange', arguments: [arg] }),
      new vscode.CodeLens(range, { title: '$(discard) Undo', command: 'builder.undoChange', arguments: [arg] }),
      new vscode.CodeLens(range, { title: '$(diff) Diff', command: 'builder.diffChange', arguments: [arg] }),
    ];
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

export class RpcNotFound extends Error {
  readonly code = -32002;
  constructor(p: string) {
    super(`File not found: ${p}`);
  }
}
