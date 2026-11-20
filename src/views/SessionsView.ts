import * as vscode from 'vscode';
import * as path from 'node:path';
import { SessionSummary, listBuilderSessions, listCliSessions } from '../puppy/files';
import type { ChatManager } from '../chat/ChatManager';
import { settings } from '../config';

type Node = GroupNode | SessionNode;
class GroupNode {
  constructor(public readonly label: string, public readonly sessions: SessionSummary[], public readonly collapsed = false, public readonly icon = 'history') {}
}
export class SessionNode {
  constructor(public readonly s: SessionSummary) {}
}

export function relTime(ms: number): string {
  const d = Date.now() - ms;
  const m = Math.floor(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

export class SessionsProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly mgr: ChatManager) {
    mgr.onDidChangeSessions(() => this.refresh());
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  private inWorkspace(cwd?: string): boolean {
    const roots = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    if (!roots.length) return true;
    if (!cwd) return false;
    return roots.some((r) => cwd === r || cwd.startsWith(r + path.sep));
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n instanceof GroupNode) {
      const item = new vscode.TreeItem(
        `${n.label} (${n.sessions.length})`,
        n.sessions.length === 0 ? vscode.TreeItemCollapsibleState.None : n.collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon(n.icon);
      return item;
    }
    const s = n.s;
    const item = new vscode.TreeItem(s.title, vscode.TreeItemCollapsibleState.None);
    item.description = `${relTime(s.updatedAt)}${s.messageCount ? ` · ${s.messageCount} msgs` : ''}`;
    item.tooltip = new vscode.MarkdownString(`**${s.title}**\n\n${s.subtitle ? s.subtitle + '\n\n' : ''}\`${s.cwd ?? ''}\`\n\n_${s.source === 'cli' ? 'Terminal (code-puppy CLI)' : 'Builder'} session_ · ${new Date(s.updatedAt).toLocaleString()}`);
    item.iconPath = new vscode.ThemeIcon(s.source === 'cli' ? 'terminal' : 'comment-discussion');
    item.contextValue = s.source === 'cli' ? 'cliSession' : 'session';
    item.command = { command: 'builder.openSession', title: 'Open', arguments: [n] };
    return item;
  }

  /** Every saved session (Builder and terminal), split into this workspace / elsewhere, newest first. */
  partition(): { here: SessionSummary[]; elsewhere: SessionSummary[] } {
    const dir = settings.configDir;
    const all = [...listBuilderSessions(dir, this.mgr.titles()), ...listCliSessions(dir)].sort((a, b) => b.updatedAt - a.updatedAt);
    return { here: all.filter((s) => this.inWorkspace(s.cwd)), elsewhere: all.filter((s) => !this.inWorkspace(s.cwd)) };
  }

  getChildren(n?: Node): Node[] {
    if (n instanceof GroupNode) return n.sessions.map((s) => new SessionNode(s));
    if (n) return [];
    const dir = settings.configDir;
    const builder = listBuilderSessions(dir, this.mgr.titles());
    const cli = listCliSessions(dir);
    const here = (l: SessionSummary[]) => l.filter((s) => this.inWorkspace(s.cwd));
    const elsewhere = [...builder, ...cli].filter((s) => !this.inWorkspace(s.cwd)).sort((a, b) => b.updatedAt - a.updatedAt);
    return [
      new GroupNode('Builder sessions · this workspace', here(builder), false, 'comment-discussion'),
      new GroupNode('Terminal sessions · this workspace', here(cli).slice(0, 100), false, 'terminal'),
      new GroupNode('Other folders', elsewhere.slice(0, 100), true, 'folder'),
    ];
  }
}
