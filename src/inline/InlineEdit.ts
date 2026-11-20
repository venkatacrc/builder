import * as vscode from 'vscode';
import type { UtilityAgent } from '../agent/UtilityAgent';
import type { ChangeTracker } from '../edits/ChangeTracker';
import type { Logger } from '../util/log';
import { buildInlinePrompt, extractCode } from './text';

export async function runInlineEdit(deps: { utility: UtilityAgent; changes: ChangeTracker; log: Logger }): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;
  let sel = editor.selection;
  let mode: string;
  if (!sel.isEmpty) {
    mode = `selection (${sel.end.line - sel.start.line + 1} line${sel.end.line === sel.start.line ? '' : 's'})`;
  } else if (doc.lineAt(sel.active.line).text.trim()) {
    sel = new vscode.Selection(doc.lineAt(sel.active.line).range.start, doc.lineAt(sel.active.line).range.end);
    mode = `line ${sel.start.line + 1}`;
  } else {
    mode = 'generate at cursor';
  }

  const instruction = await vscode.window.showInputBox({
    title: `Builder · Inline edit — ${mode}`,
    prompt: 'Describe the change (Enter to apply, Esc to cancel)',
    placeHolder: 'e.g. add input validation and early returns',
    ignoreFocusOut: true,
  });
  if (!instruction?.trim()) return;

  const start = doc.offsetAt(sel.start);
  const end = doc.offsetAt(sel.end);
  const text = doc.getText();
  const beforeLines = text.slice(0, start).split('\n');
  const afterLines = text.slice(end).split('\n');
  const prompt = buildInlinePrompt({
    rel: vscode.workspace.asRelativePath(doc.uri, false),
    lang: doc.languageId,
    instruction: instruction.trim(),
    before: beforeLines.slice(-60).join('\n'),
    selected: text.slice(start, end),
    after: afterLines.slice(0, 40).join('\n'),
  });

  let answer = '';
  const startedAt = Date.now();
  try {
    answer = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Builder: editing…', cancellable: true },
      async (progress, token) => {
        const timer = setTimeout(() => progress.report({ message: 'starting the agent (first use can take ~30 s)…' }), 4000);
        try {
          return await deps.utility.run(prompt, { token });
        } finally {
          clearTimeout(timer);
        }
      },
    );
  } catch (e) {
    deps.log.error('inline edit failed', e);
    void vscode.window.showErrorMessage(`Builder inline edit failed: ${(e as Error).message}`);
    return;
  }
  if (!answer.trim()) return; // cancelled or empty
  deps.log.info(`inline edit done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  let replacement = extractCode(answer);
  // The selection never includes the trailing newline of its last line; keep it that way.
  if (!text.slice(start, end).endsWith('\n')) replacement = replacement.replace(/\n$/, '');
  const current = doc.getText();
  if (current.slice(start, end) !== text.slice(start, end)) {
    void vscode.window.showWarningMessage('The file changed while the edit was generated; not applying.');
    return;
  }
  const next = current.slice(0, start) + replacement + current.slice(end);
  if (doc.uri.scheme === 'file') {
    await deps.changes.applyWrite('inline-edit', doc.uri.fsPath, next);
    const first = doc.positionAt(start);
    editor.revealRange(new vscode.Range(first, first), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    void vscode.window.setStatusBarMessage('Builder: edit applied — use the Keep / Undo lenses above the change', 6000);
  } else {
    await editor.edit((b) => b.replace(new vscode.Range(doc.positionAt(start), doc.positionAt(end)), replacement));
  }
}
