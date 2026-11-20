import * as vscode from 'vscode';
import * as path from 'node:path';
import type { ContentBlock } from '../acp/types';
import type { AttachmentView } from '../shared/protocol';
import { uid } from '../util/log';
import { settings } from '../config';

interface AttachmentPayload {
  view: AttachmentView;
  kind: AttachmentView['kind'];
  uri?: vscode.Uri;
  selection?: { text: string; startLine: number; endLine: number; languageId: string };
  image?: { mime: string; data: string };
}

const MAX_FILE_BYTES = 200_000;
const MAX_FOLDER_ENTRIES = 300;

/** Turns @mentions / selections / pasted images into ACP content blocks. */
export class ContextResolver implements vscode.Disposable {
  private payloads = new Map<string, AttachmentPayload>();
  /** `activeTextEditor` is undefined while the chat webview has focus, so remember the last real one. */
  private lastEditor?: vscode.TextEditor;
  private sub: vscode.Disposable;

  constructor() {
    this.lastEditor = vscode.window.activeTextEditor;
    this.sub = vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e && e.document.uri.scheme !== 'output') this.lastEditor = e;
    });
  }

  dispose(): void {
    this.sub.dispose();
  }

  currentEditor(): vscode.TextEditor | undefined {
    const e = vscode.window.activeTextEditor ?? this.lastEditor;
    return e && !e.document.isClosed ? e : undefined;
  }

  private register(p: AttachmentPayload): AttachmentView {
    this.payloads.set(p.view.id, p);
    return p.view;
  }

  rel(uri: vscode.Uri): string {
    return vscode.workspace.asRelativePath(uri, false);
  }

  fileAttachment(uri: vscode.Uri): AttachmentView {
    return this.register({
      kind: 'file',
      uri,
      view: { id: uid('att'), kind: 'file', label: path.basename(uri.fsPath), detail: this.rel(uri) },
    });
  }

  folderAttachment(uri: vscode.Uri): AttachmentView {
    return this.register({
      kind: 'folder',
      uri,
      view: { id: uid('att'), kind: 'folder', label: path.basename(uri.fsPath) + '/', detail: this.rel(uri) },
    });
  }

  selectionAttachment(editor: vscode.TextEditor): AttachmentView | undefined {
    const sel = editor.selection;
    if (sel.isEmpty) return undefined;
    const text = editor.document.getText(sel);
    const startLine = sel.start.line + 1;
    const endLine = sel.end.line + 1;
    return this.register({
      kind: 'selection',
      uri: editor.document.uri,
      selection: { text, startLine, endLine, languageId: editor.document.languageId },
      view: {
        id: uid('att'),
        kind: 'selection',
        label: `${path.basename(editor.document.uri.fsPath)}:${startLine}-${endLine}`,
        detail: `${text.length} chars selected`,
      },
    });
  }

  problemsAttachment(): AttachmentView {
    return this.register({ kind: 'problems', view: { id: uid('att'), kind: 'problems', label: 'Problems', detail: 'Workspace diagnostics' } });
  }

  imageAttachment(name: string, mime: string, base64: string): AttachmentView {
    return this.register({
      kind: 'image',
      image: { mime, data: base64 },
      view: { id: uid('att'), kind: 'image', label: name || 'image', thumb: `data:${mime};base64,${base64}` },
    });
  }

  /** @mention search: special items + files + folders matching the query. */
  async search(query: string): Promise<AttachmentView[]> {
    const q = query.trim();
    const results: AttachmentView[] = [];
    const editor = this.currentEditor();
    const lower = q.toLowerCase();
    if (editor && !editor.selection.isEmpty && 'selection'.startsWith(lower)) {
      const s = this.selectionAttachment(editor);
      if (s) results.push(s);
    }
    if ('problems'.startsWith(lower)) results.push(this.problemsAttachment());

    const glob = q ? `**/*${q.replace(/[^\w.\-/]/g, '?').split('').join('*').slice(0, 120)}*` : '**/*';
    const exclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.venv/**,**/__pycache__/**,**/.DS_Store}';
    try {
      const files = await vscode.workspace.findFiles(glob, exclude, 40);
      const scored = files
        .map((u) => ({ u, score: score(this.rel(u), lower) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 12);
      for (const { u } of scored) results.push(this.fileAttachment(u));
      // Folders implied by matching files.
      const folders = new Set<string>();
      for (const { u } of scored) {
        const d = path.dirname(this.rel(u));
        if (d !== '.' && d.toLowerCase().includes(lower) && folders.size < 3) folders.add(d);
      }
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (root) for (const f of folders) results.push(this.folderAttachment(vscode.Uri.joinPath(root, f)));
    } catch {
      /* findFiles can fail with no workspace */
    }
    return results;
  }

  // -------------------------------------------------------------- prompt building ---

  editorContextBlock(): ContentBlock | undefined {
    if (!settings.includeActiveEditorContext) return undefined;
    const editor = this.currentEditor();
    if (!editor || editor.document.uri.scheme !== 'file') return undefined;
    const lines = [`[Editor context] Active file: ${this.rel(editor.document.uri)} (${editor.document.languageId})`];
    lines.push(`Cursor: line ${editor.selection.active.line + 1}, column ${editor.selection.active.character + 1}`);
    if (!editor.selection.isEmpty) lines.push(`Selection: lines ${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`);
    const open = vscode.window.visibleTextEditors
      .filter((e) => e.document.uri.scheme === 'file' && e !== editor)
      .map((e) => this.rel(e.document.uri));
    if (open.length) lines.push(`Other visible files: ${[...new Set(open)].join(', ')}`);
    return { type: 'text', text: lines.join('\n') };
  }

  async blocksFor(text: string, attachmentIds: string[]): Promise<{ blocks: ContentBlock[]; views: AttachmentView[] }> {
    const blocks: ContentBlock[] = [];
    const views: AttachmentView[] = [];
    const ctx = this.editorContextBlock();
    if (ctx) blocks.push(ctx);
    for (const id of attachmentIds) {
      const p = this.payloads.get(id);
      if (!p) continue;
      views.push(p.view);
      const block = await this.blockFor(p);
      if (block) blocks.push(block);
    }
    blocks.push({ type: 'text', text });
    return { blocks, views };
  }

  forget(ids: string[]): void {
    for (const id of ids) this.payloads.delete(id);
  }

  private async blockFor(p: AttachmentPayload): Promise<ContentBlock | undefined> {
    switch (p.kind) {
      case 'file': {
        const content = await this.readFileCapped(p.uri!);
        return { type: 'resource', resource: { uri: p.uri!.toString(), mimeType: 'text/plain', text: content } };
      }
      case 'folder':
        return {
          type: 'resource',
          resource: { uri: p.uri!.toString(), mimeType: 'text/plain', text: await this.folderListing(p.uri!) },
        };
      case 'selection': {
        const s = p.selection!;
        return {
          type: 'resource',
          resource: {
            uri: `${p.uri!.toString()}#L${s.startLine}-L${s.endLine}`,
            mimeType: 'text/plain',
            text: `Selected lines ${s.startLine}-${s.endLine} of ${this.rel(p.uri!)} (${s.languageId}):\n${s.text}`,
          },
        };
      }
      case 'problems':
        return { type: 'resource', resource: { uri: 'builder://problems', mimeType: 'text/plain', text: this.problemsText() } };
      case 'image':
        return { type: 'image', data: p.image!.data, mimeType: p.image!.mime };
    }
    return undefined;
  }

  private async readFileCapped(uri: vscode.Uri): Promise<string> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    let text: string;
    if (open) text = open.getText();
    else {
      try {
        text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      } catch (e) {
        return `[could not read ${uri.fsPath}: ${(e as Error).message}]`;
      }
    }
    if (text.length > MAX_FILE_BYTES) text = text.slice(0, MAX_FILE_BYTES) + `\n[... truncated at ${MAX_FILE_BYTES} characters]`;
    return `File: ${this.rel(uri)}\n${text}`;
  }

  private async folderListing(uri: vscode.Uri): Promise<string> {
    const lines: string[] = [];
    const walk = async (dir: vscode.Uri, depth: number): Promise<void> => {
      if (lines.length >= MAX_FOLDER_ENTRIES || depth > 3) return;
      let entries: [string, vscode.FileType][] = [];
      try {
        entries = await vscode.workspace.fs.readDirectory(dir);
      } catch {
        return;
      }
      entries.sort((a, b) => a[0].localeCompare(b[0]));
      for (const [name, type] of entries) {
        if (['node_modules', '.git', 'dist', 'out', '__pycache__', '.venv'].includes(name)) continue;
        if (lines.length >= MAX_FOLDER_ENTRIES) return;
        const isDir = (type & vscode.FileType.Directory) !== 0;
        lines.push(`${'  '.repeat(depth)}${name}${isDir ? '/' : ''}`);
        if (isDir) await walk(vscode.Uri.joinPath(dir, name), depth + 1);
      }
    };
    await walk(uri, 0);
    return `Folder: ${this.rel(uri)}\n${lines.join('\n')}${lines.length >= MAX_FOLDER_ENTRIES ? '\n[... truncated]' : ''}`;
  }

  private problemsText(): string {
    const out: string[] = [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      if (uri.scheme !== 'file') continue;
      for (const d of diags) {
        if (d.severity > vscode.DiagnosticSeverity.Warning) continue;
        const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
        out.push(`${this.rel(uri)}:${d.range.start.line + 1}:${d.range.start.character + 1} ${sev}: ${d.message}`);
        if (out.length >= 150) break;
      }
      if (out.length >= 150) break;
    }
    return out.length ? `Workspace problems:\n${out.join('\n')}` : 'No errors or warnings in the workspace.';
  }
}

function score(rel: string, q: string): number {
  if (!q) return 0;
  const l = rel.toLowerCase();
  const base = path.basename(l);
  if (base === q) return 100;
  if (base.startsWith(q)) return 80;
  if (base.includes(q)) return 60;
  if (l.includes(q)) return 40;
  return 10 - Math.min(9, rel.length / 20);
}
