import * as vscode from 'vscode';
import * as path from 'node:path';
import type { ChangeRecord, ChangeTracker } from '../edits/ChangeTracker';

export class ChangeNode {
  constructor(public readonly record: ChangeRecord) {}
}

export class ChangesProvider implements vscode.TreeDataProvider<ChangeNode> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly changes: ChangeTracker) {
    changes.onDidChangeRecords(() => this._onDidChange.fire());
  }

  getTreeItem(n: ChangeNode): vscode.TreeItem {
    const r = n.record;
    const item = new vscode.TreeItem(path.basename(r.path), vscode.TreeItemCollapsibleState.None);
    item.description = `${vscode.workspace.asRelativePath(path.dirname(r.path), false)} · ${r.original === null ? 'new file' : 'modified'}`;
    item.resourceUri = vscode.Uri.file(r.path);
    item.contextValue = 'change';
    item.tooltip = r.path;
    item.command = { command: 'builder.diffChange', title: 'Show diff', arguments: [n] };
    return item;
  }

  getChildren(): ChangeNode[] {
    return this.changes.all().map((r) => new ChangeNode(r));
  }
}
