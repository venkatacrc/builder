import * as vscode from 'vscode';
import * as path from 'node:path';
import { ChatManager } from './ChatManager';
import type { HostToWebview, WebviewToHost } from '../shared/protocol';
import { uid } from '../util/log';
import { builderSessionFile, locateCodePuppy } from '../puppy/files';
import { settings } from '../config';
import { getShellEnv } from '../util/shellEnv';

/** Wires one webview (sidebar view or editor tab) to the ChatManager. */
export class ChatBridge {
  constructor(private readonly mgr: ChatManager, private readonly ctx: vscode.ExtensionContext) {}

  attach(webview: vscode.Webview, visible: () => boolean): vscode.Disposable {
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'dist')] };
    webview.html = this.html(webview);
    const subs: vscode.Disposable[] = [];
    subs.push(
      this.mgr.addListener((m: HostToWebview) => {
        void webview.postMessage(m);
      }),
      webview.onDidReceiveMessage((m: WebviewToHost) => void this.onMessage(webview, m)),
    );
    void visible;
    return vscode.Disposable.from(...subs);
  }

  private html(webview: vscode.Webview): string {
    const dist = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
    const nonce = uid('n');
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${css}" rel="stylesheet">
<title>Builder</title></head>
<body><div id="app"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
  }

  private async onMessage(webview: vscode.Webview, m: WebviewToHost): Promise<void> {
    const mgr = this.mgr;
    try {
      switch (m.t) {
        case 'ready': {
          void webview.postMessage({ t: 'trust', trusted: vscode.workspace.isTrusted } satisfies HostToWebview);
          mgr.pool.prewarm();
          if (mgr.chats.length === 0) mgr.newChat();
          else mgr.select(mgr.activeId ?? mgr.chats[0].id);
          return;
        }
        case 'send':
          await mgr.get(m.chatId)?.send(m.text, m.attachmentIds);
          return;
        case 'cancel':
          mgr.get(m.chatId)?.cancel();
          return;
        case 'newChat':
          if (await mgr.confirmLeave()) mgr.newChat();
          return;
        case 'setModel':
          await mgr.get(m.chatId)?.setModel(m.model);
          return;
        case 'setAutoApprove': {
          const chat = mgr.get(m.chatId);
          if (!chat) return;
          if (m.value) {
            const pick = await vscode.window.showWarningMessage(
              'Auto-run lets the agent edit files and run shell commands without asking. Enable for this chat?',
              { modal: true },
              'Enable',
            );
            if (pick !== 'Enable') {
              chat.refreshInfo();
              return;
            }
          }
          chat.setAutoApprove(m.value);
          return;
        }
        case 'permission':
          mgr.get(m.chatId)?.resolvePermission(m.requestId, m.optionId);
          return;
        case 'searchMentions': {
          const results = await mgr.context.search(m.query);
          void webview.postMessage({ t: 'mentions', reqId: m.reqId, results } satisfies HostToWebview);
          return;
        }
        case 'addImage': {
          const att = mgr.context.imageAttachment(m.name, m.mime, m.data);
          void webview.postMessage({ t: 'attachment', attachment: att } satisfies HostToWebview);
          return;
        }
        case 'pickFile': {
          const root = vscode.workspace.workspaceFolders?.[0]?.uri;
          const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: true, defaultUri: root, openLabel: 'Attach' });
          for (const uri of picked ?? []) {
            const stat = await vscode.workspace.fs.stat(uri);
            const att = stat.type & vscode.FileType.Directory ? mgr.context.folderAttachment(uri) : mgr.context.fileAttachment(uri);
            void webview.postMessage({ t: 'attachment', attachment: att } satisfies HostToWebview);
          }
          return;
        }
        case 'openFile':
          await openPath(m.path, m.line, mgr.active()?.cwd);
          return;
        case 'copy':
          await vscode.env.clipboard.writeText(m.text);
          return;
        case 'insertCode': {
          const editor = mgr.context.currentEditor() ?? vscode.window.visibleTextEditors[0];
          if (!editor) {
            void vscode.window.showWarningMessage('Open a file to insert code into.');
            return;
          }
          await editor.edit((b) => b.replace(editor.selection, m.text));
          return;
        }
        case 'reviewChanges':
          await mgr.changes.reviewNext(m.chatId);
          return;
        case 'keepAll':
          mgr.changes.keepAll(m.chatId);
          return;
        case 'undoAll':
          await mgr.changes.undoAll(m.chatId);
          return;
        case 'showSessions':
          await vscode.commands.executeCommand('builder.showHistory');
          return;
        case 'manageTrust':
          await vscode.commands.executeCommand('workbench.trust.manage');
          return;
        case 'openInTerminal': {
          const chat = mgr.get(m.chatId);
          if (chat?.persistentSessionId) await openSessionInTerminal(builderSessionFile(settings.configDir, chat.persistentSessionId), chat.cwd);
          else void vscode.window.showInformationMessage('Send a message first — the session is saved after the first reply.');
          return;
        }
      }
    } catch (e) {
      mgr.log.error(`webview message '${m.t}' failed`, e);
      void vscode.window.showErrorMessage(`Builder: ${(e as Error).message}`);
    }
  }
}

export async function openPath(p: string, line?: number, base?: string): Promise<void> {
  const abs = path.isAbsolute(p) ? p : path.join(base ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', p);
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
    const pos = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
  } catch {
    void vscode.window.showWarningMessage(`Could not open ${abs}`);
  }
}

/** Resume a Builder session in the terminal CLI (`code-puppy --resume <session.json>`). */
export async function openSessionInTerminal(sessionFile: string, cwd?: string): Promise<void> {
  const install = locateCodePuppy(settings.codePuppyPath || undefined, await getShellEnv());
  const exe = install?.executable ?? 'code-puppy';
  const term = vscode.window.createTerminal({ name: 'code-puppy (resume)', cwd });
  term.show();
  term.sendText(`${shellQuote(exe)} --resume ${shellQuote(sessionFile)}`);
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'builder.chat';
  private view?: vscode.WebviewView;

  constructor(private readonly bridge: ChatBridge) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const sub = this.bridge.attach(view.webview, () => view.visible);
    view.onDidDispose(() => {
      sub.dispose();
      if (this.view === view) this.view = undefined;
    });
  }

  get visible(): boolean {
    return !!this.view?.visible;
  }

  async reveal(): Promise<void> {
    if (this.view) this.view.show?.(true);
    else await vscode.commands.executeCommand('builder.chat.focus');
  }
}

export class ChatPanel {
  private static panel?: vscode.WebviewPanel;

  static open(bridge: ChatBridge, ctx: vscode.ExtensionContext): void {
    if (ChatPanel.panel) {
      ChatPanel.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('builder.chatPanel', 'Builder', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist')],
    });
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'builder.svg');
    const sub = bridge.attach(panel.webview, () => panel.visible);
    panel.onDidDispose(() => {
      sub.dispose();
      ChatPanel.panel = undefined;
    });
    ChatPanel.panel = panel;
  }
}
