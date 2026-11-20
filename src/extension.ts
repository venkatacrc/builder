import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { AgentPool, AgentRuntime } from './agent/runtime';
import { UtilityAgent } from './agent/UtilityAgent';
import { ChatManager } from './chat/ChatManager';
import { ChatBridge, ChatPanel, ChatViewProvider, openSessionInTerminal } from './chat/ChatView';
import { settings, setSetting } from './config';
import { ContextResolver } from './context/ContextResolver';
import { ChangeTracker } from './edits/ChangeTracker';
import { runInlineEdit } from './inline/InlineEdit';
import { TabCompletionProvider } from './inline/TabCompletion';
import { SessionSummary, builderSessionFile, deleteBuilderSession, readUserModels } from './puppy/files';
import { TerminalManager } from './terminal/TerminalManager';
import { Logger } from './util/log';
import { ChangeNode, ChangesProvider } from './views/ChangesView';
import { McpProvider, registerMcpCommands } from './views/McpView';
import { SessionNode, SessionsProvider, relTime } from './views/SessionsView';
import { getShellEnv } from './util/shellEnv';

export function activate(ctx: vscode.ExtensionContext): void {
  const log = new Logger();
  const runtime = new AgentRuntime(ctx, log);
  const pool = new AgentPool(runtime, log);
  const changes = new ChangeTracker(log);
  const terminals = new TerminalManager();
  const context = new ContextResolver();
  const mgr = new ChatManager(ctx, runtime, pool, changes, terminals, context, log);

  const editUtility = new UtilityAgent(runtime, log, 'inline-edit', () => settings.inlineEditModel);
  const tabUtility = new UtilityAgent(runtime, log, 'tab', () => settings.tabModel);
  const tab = new TabCompletionProvider(tabUtility, log);

  const bridge = new ChatBridge(mgr, ctx);
  const chatProvider = new ChatViewProvider(bridge);
  mgr.bindView({ isVisible: () => chatProvider.visible, reveal: () => void chatProvider.reveal() });

  const sessions = new SessionsProvider(mgr);
  const changesView = new ChangesProvider(changes);
  const mcp = new McpProvider();

  ctx.subscriptions.push(
    log,
    changes,
    terminals,
    context,
    mgr,
    editUtility,
    tabUtility,
    tab,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chatProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerTreeDataProvider('builder.sessions', sessions),
    vscode.window.registerTreeDataProvider('builder.changes', changesView),
    vscode.window.registerTreeDataProvider('builder.mcp', mcp),
  );

  // ---------------------------------------------------------------- status bar ---
  const modelItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  modelItem.command = 'builder.selectModel';
  const pendingItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  pendingItem.command = 'builder.reviewChanges';
  const updateStatus = () => {
    const chat = mgr.active();
    modelItem.text = `$(hubot) ${chat?.model ?? 'Builder'}${chat?.status === 'running' ? ' $(sync~spin)' : ''}`;
    modelItem.tooltip = `Builder — model for the active chat (${chat?.agent ?? 'no chat'}). Click to change.`;
    modelItem.show();
    const n = changes.count();
    if (n) {
      pendingItem.text = `$(diff) ${n} pending`;
      pendingItem.tooltip = 'Agent edits waiting for review';
      pendingItem.show();
    } else pendingItem.hide();
  };
  ctx.subscriptions.push(modelItem, pendingItem, mgr.addListener(updateStatus), changes.onDidChangeRecords(updateStatus));
  updateStatus();

  // ------------------------------------------------------------------- commands ---
  const reg = (id: string, fn: (...a: any[]) => any) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const reveal = async () => {
    await chatProvider.reveal();
  };

  reg('builder.newChat', async () => {
    await reveal();
    if (!(await mgr.confirmLeave())) return;
    mgr.newChat();
    mgr.broadcast({ t: 'focusInput' });
  });
  reg('builder.openChatInEditor', () => ChatPanel.open(bridge, ctx));
  reg('builder.focusChat', async () => {
    await reveal();
    mgr.broadcast({ t: 'focusInput' });
  });
  reg('builder.addSelectionToChat', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const att = context.selectionAttachment(editor) ?? context.fileAttachment(editor.document.uri);
    await reveal();
    mgr.broadcast({ t: 'attachment', attachment: att });
  });
  reg('builder.addFileToChat', async (uri?: vscode.Uri) => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) return;
    const stat = await vscode.workspace.fs.stat(target);
    const att = stat.type & vscode.FileType.Directory ? context.folderAttachment(target) : context.fileAttachment(target);
    await reveal();
    mgr.broadcast({ t: 'attachment', attachment: att });
  });
  reg('builder.inlineEdit', () => runInlineEdit({ utility: editUtility, changes, log }));
  reg('builder.toggleTabCompletion', async () => {
    const next = !settings.tabEnabled;
    await setSetting('tabCompletion.enabled', next);
    tab.refreshStatus();
    if (next && !settings.tabModel) {
      const pick = await vscode.window.showInformationMessage(
        'Tab autocomplete is on, using the Code Puppy default model — that can be slow. Choose a fast model for it?',
        'Choose model',
        'Later',
      );
      if (pick === 'Choose model') {
        const cat = await runtime.catalog();
        const model = await vscode.window.showQuickPick(cat.models, { placeHolder: 'Model for Tab autocomplete (pick a small/fast one)' });
        if (model) await setSetting('tabCompletion.model', model);
      }
    }
  });
  reg('builder.selectModel', async () => {
    const chat = mgr.active();
    if (!chat) return;
    const list = chat.models.length ? chat.models.map((m) => m.id) : readUserModels(settings.configDir).map((m) => m.id);
    const pick = await vscode.window.showQuickPick(
      list.map((id) => ({ label: id, description: id === chat.model ? 'current' : '' })),
      { placeHolder: 'Select model for this chat' },
    );
    if (pick) await chat.setModel(pick.label);
  });
  const pathOf = (arg: unknown): string | undefined => (typeof arg === 'string' ? arg : arg instanceof ChangeNode ? arg.record.path : undefined);
  reg('builder.reviewChanges', () => changes.reviewNext(mgr.active()?.id));
  reg('builder.keepAllChanges', () => changes.keepAll());
  reg('builder.undoAllChanges', () => changes.undoAll());
  reg('builder.keepChange', (arg) => {
    const p = pathOf(arg) ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    if (p) changes.keep(p);
  });
  reg('builder.undoChange', async (arg) => {
    const p = pathOf(arg) ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    if (p) await changes.undo(p);
  });
  reg('builder.diffChange', async (arg) => {
    const p = pathOf(arg) ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    if (p) await changes.showDiff(p);
  });

  reg('builder.refreshSessions', () => sessions.refresh());
  const openSession = async (s: SessionSummary) => {
    await reveal();
    if (mgr.active()?.persistentSessionId !== s.id && !(await mgr.confirmLeave())) return;
    mgr.openSession(s);
  };
  reg('builder.openSession', async (arg?: SessionNode) => {
    if (arg) await openSession(arg.s);
  });
  reg('builder.showHistory', async () => {
    const { here, elsewhere } = sessions.partition();
    type Pick = vscode.QuickPickItem & { s?: SessionSummary };
    const row = (s: SessionSummary): Pick => ({
      label: `$(${s.source === 'cli' ? 'terminal' : 'comment-discussion'}) ${s.title}`,
      description: relTime(s.updatedAt),
      detail: s.source === 'cli' ? 'Terminal session' : undefined,
      s,
    });
    const items: Pick[] = [
      { label: 'This workspace', kind: vscode.QuickPickItemKind.Separator },
      ...here.slice(0, 200).map(row),
      { label: 'Other folders', kind: vscode.QuickPickItemKind.Separator },
      ...elsewhere.slice(0, 200).map(row),
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Open a past chat (Builder or code-puppy terminal session)', matchOnDetail: true });
    if (pick?.s) await openSession(pick.s);
  });
  reg('builder.openSessionInTerminal', async (arg?: SessionNode) => {
    if (!arg) return;
    await openSessionInTerminal(arg.s.file, arg.s.cwd);
  });
  reg('builder.deleteSession', async (arg?: SessionNode) => {
    if (!arg) return;
    if (arg.s.source === 'cli') {
      void vscode.window.showInformationMessage('Terminal sessions are managed by the code-puppy CLI; Builder will not delete them.');
      return;
    }
    const ok = await vscode.window.showWarningMessage(`Delete session “${arg.s.title}”? This removes its saved history.`, { modal: true }, 'Delete');
    if (ok !== 'Delete') return;
    if (mgr.active()?.persistentSessionId === arg.s.id) {
      if (!(await mgr.confirmLeave())) return;
      mgr.newChat();
    }
    deleteBuilderSession(settings.configDir, arg.s.id);
    sessions.refresh();
  });

  ctx.subscriptions.push(...registerMcpCommands({ provider: mcp, restartAgents: () => mgr.restartAgents() }));

  reg('builder.restartAgents', async () => {
    await mgr.restartAgents();
    editUtility.stop();
    tabUtility.stop();
    void vscode.window.showInformationMessage('Builder: agent processes restarted. Chats resume on your next message.');
  });
  reg('builder.showLog', () => log.show());
  reg('builder.doctor', () => runDoctor(ctx, runtime, log));

  // --------------------------------------------------------------------- events ---
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (['codePuppyPath', 'useLauncher', 'configDir', 'agent'].some((k) => e.affectsConfiguration(`builder.${k}`))) {
        runtime.resetInstallCache();
        void vscode.window
          .showInformationMessage('Builder: Code Puppy settings changed. Restart agent processes to apply?', 'Restart agents')
          .then((c) => c && vscode.commands.executeCommand('builder.restartAgents'));
        sessions.refresh();
        mcp.refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => sessions.refresh()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      runtime.invalidateCatalog();
      void runtime.refreshedCatalog().then(() => mgr.broadcastChats());
      mgr.onTrustGranted();
    }),
  );

  // ------------------------------------------------------------------- start up ---
  mgr.restoreOpenChats((sid) => {
    const f = builderSessionFile(settings.configDir, sid);
    return fs.existsSync(f) ? f : undefined;
  });
  void getShellEnv(); // resolve the login-shell environment early (used by every spawn)
  void runtime.refreshedCatalog().then(() => mgr.broadcastChats());
  // The warm spare agent is started lazily, when the chat view is first shown (see ChatBridge 'ready').
  log.info(`Builder activated. config dir: ${settings.configDir}`);
}

export function deactivate(): void {
  /* disposables are cleaned up through ctx.subscriptions */
}

async function runDoctor(ctx: vscode.ExtensionContext, runtime: AgentRuntime, log: Logger): Promise<void> {
  log.show();
  const say = (s: string) => log.info(`[doctor] ${s}`);
  say('--- Builder diagnostics ---');
  const env = await getShellEnv();
  say(`login-shell PATH resolved: ${env.PATH ? 'yes' : 'NO'} (${(env.PATH ?? '').split(':').length} entries)`);
  const install = await runtime.install();
  if (!install) {
    say('code-puppy NOT FOUND. Install: curl -skSL https://puppy.walmart.com/api/releases/setup_v2 | bash   or set builder.codePuppyPath');
    void vscode.window.showErrorMessage('Builder: code-puppy not found. See the Builder log.');
    return;
  }
  say(`code-puppy: ${install.executable}`);
  say(`venv python: ${install.python ?? '(none found — launcher and catalog disabled)'}`);
  say(`config dir: ${settings.configDir} (${fs.existsSync(settings.configDir) ? 'exists' : 'MISSING'})`);
  say(`models.json entries: ${readUserModels(settings.configDir).length}`);
  say(`launcher: ${settings.useLauncher && install.python ? 'enabled (model picks do not touch puppy.cfg)' : 'disabled'}`);
  const t0 = Date.now();
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Builder: testing agent startup (can take 10–30 s)…' }, async () => {
      const pooled = await runtime.spawnPooled('doctor');
      const sess = await pooled.agent.newSession(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd());
      const model = sess.configOptions?.find((o) => o.category === 'model');
      say(`ACP handshake OK in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${pooled.agent.info?.agentInfo?.title} ${pooled.agent.info?.agentInfo?.version}`);
      say(`models offered over ACP: ${model?.options.length ?? 0}; current: ${model?.currentValue}`);
      await pooled.agent.closeSession(sess.sessionId);
      pooled.proc.dispose();
    });
    void vscode.window.showInformationMessage('Builder: everything looks good. Details are in the Builder log.');
  } catch (e) {
    say(`FAILED: ${(e as Error).message}`);
    void vscode.window.showErrorMessage('Builder: agent startup failed. See the Builder log.');
  }
  void ctx;
}
