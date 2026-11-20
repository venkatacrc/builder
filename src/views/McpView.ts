import * as vscode from 'vscode';
import { McpServer, addMcpServer, listMcpServers, mcpServersFile, readMarketplace, removeMcpServer, setMcpEnabled } from '../puppy/files';
import { settings } from '../config';

export class McpNode {
  constructor(public readonly server: McpServer) {}
}

const redact = (raw: any) =>
  JSON.stringify(
    raw,
    (k, v) => (/authorization|token|secret|password|api[-_]?key/i.test(k) && typeof v === 'string' ? '«redacted»' : v),
    2,
  );

export class McpProvider implements vscode.TreeDataProvider<McpNode> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(n: McpNode): vscode.TreeItem {
    const s = n.server;
    const item = new vscode.TreeItem(s.name, vscode.TreeItemCollapsibleState.None);
    item.description = `${s.enabled ? '' : 'disabled · '}${s.type}${s.url ? ' · ' + s.url.replace(/^https?:\/\//, '') : s.command ? ' · ' + s.command : ''}`;
    item.iconPath = new vscode.ThemeIcon(s.enabled ? 'plug' : 'circle-slash', s.enabled ? undefined : new vscode.ThemeColor('disabledForeground'));
    item.contextValue = 'mcpServer';
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${s.name}** — ${s.enabled ? 'enabled' : 'disabled'}\n\nDefined in \`${s.source}\`\n`);
    md.appendCodeblock(redact(s.raw?.config ?? s.raw), 'json');
    item.tooltip = md;
    return item;
  }

  getChildren(): McpNode[] {
    return listMcpServers(settings.configDir).map((s) => new McpNode(s));
  }
}

export interface McpCommandDeps {
  provider: McpProvider;
  restartAgents(): Promise<void>;
}

function offerRestart(deps: McpCommandDeps): void {
  void vscode.window
    .showInformationMessage('MCP configuration changed. Restart agent processes to apply it? (chats resume automatically)', 'Restart agents')
    .then((c) => c && deps.restartAgents());
}

async function pickServer(arg: McpNode | undefined, only?: (s: McpServer) => boolean): Promise<McpServer | undefined> {
  if (arg) return arg.server;
  const list = listMcpServers(settings.configDir).filter((s) => !only || only(s));
  const pick = await vscode.window.showQuickPick(
    list.map((s) => ({ label: s.name, description: s.enabled ? 'enabled' : 'disabled', server: s })),
    { placeHolder: 'Select an MCP server' },
  );
  return pick?.server;
}

export function registerMcpCommands(deps: McpCommandDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('builder.refreshMcp', () => deps.provider.refresh()),
    vscode.commands.registerCommand('builder.mcpOpenConfig', async () => {
      await vscode.window.showTextDocument(vscode.Uri.file(mcpServersFile(settings.configDir)));
    }),
    vscode.commands.registerCommand('builder.mcpToggle', async (arg?: McpNode) => {
      const s = await pickServer(arg);
      if (!s) return;
      try {
        setMcpEnabled(settings.configDir, s.name, !s.enabled);
        deps.provider.refresh();
        offerRestart(deps);
      } catch (e) {
        void vscode.window.showErrorMessage((e as Error).message);
      }
    }),
    vscode.commands.registerCommand('builder.mcpRemove', async (arg?: McpNode) => {
      const s = await pickServer(arg);
      if (!s) return;
      const ok = await vscode.window.showWarningMessage(`Remove MCP server '${s.name}' from Code Puppy? (A backup of the config is kept next to it.)`, { modal: true }, 'Remove');
      if (ok !== 'Remove') return;
      removeMcpServer(settings.configDir, s.name);
      deps.provider.refresh();
      offerRestart(deps);
    }),
    vscode.commands.registerCommand('builder.mcpAdd', async () => {
      const kind = await vscode.window.showQuickPick(
        [
          { label: 'Remote (HTTP / streamable)', description: 'URL, optional bearer token env var', mode: 'http' },
          { label: 'Local (stdio command)', description: 'e.g. npx -y @modelcontextprotocol/server-filesystem /path', mode: 'stdio' },
        ],
        { placeHolder: 'What kind of MCP server?' },
      );
      if (!kind) return;
      const name = await vscode.window.showInputBox({ prompt: 'Server name', validateInput: (v) => (/^[\w.-]+$/.test(v) ? undefined : 'Use letters, numbers, - _ .') });
      if (!name) return;
      try {
        if (kind.mode === 'http') {
          const url = await vscode.window.showInputBox({ prompt: 'Server URL', placeHolder: 'https://host/mcp', validateInput: (v) => (/^https?:\/\//.test(v) ? undefined : 'Must start with http(s)://') });
          if (!url) return;
          const tokenVar = await vscode.window.showInputBox({
            prompt: 'Optional: environment variable holding a bearer token (the token itself is NOT stored)',
            placeHolder: 'e.g. MY_SERVICE_TOKEN',
          });
          const cfg: Record<string, unknown> = { type: 'http', url, timeout: 30 };
          if (tokenVar?.trim()) cfg.headers = { Authorization: `Bearer $${tokenVar.trim()}` };
          addMcpServer(settings.configDir, name, cfg);
        } else {
          const cmdline = await vscode.window.showInputBox({ prompt: 'Command line', placeHolder: 'npx -y @modelcontextprotocol/server-filesystem /path' });
          if (!cmdline?.trim()) return;
          const [command, ...args] = cmdline.trim().split(/\s+/);
          addMcpServer(settings.configDir, name, { type: 'stdio', command, args });
        }
        deps.provider.refresh();
        offerRestart(deps);
      } catch (e) {
        void vscode.window.showErrorMessage((e as Error).message);
      }
    }),
    vscode.commands.registerCommand('builder.mcpBrowseMarketplace', async () => {
      const entries = readMarketplace(settings.configDir);
      if (!entries.length) {
        void vscode.window.showInformationMessage('No cached Walmart MCP marketplace found. Run `/mcp` in the code-puppy CLI once to populate it.');
        return;
      }
      const installed = new Set(listMcpServers(settings.configDir).map((s) => s.name));
      const pick = await vscode.window.showQuickPick(
        entries.map((e) => ({
          label: `${installed.has(e.name) ? '$(check) ' : ''}${e.name}`,
          description: e.tags.slice(0, 4).join(', '),
          detail: (e.description ?? '').replace(/\s+/g, ' ').slice(0, 220),
          entry: e,
        })),
        { placeHolder: `Walmart MCP marketplace (${entries.length} servers)`, matchOnDescription: true, matchOnDetail: true },
      );
      if (!pick) return;
      const e = pick.entry;
      const action = await vscode.window.showInformationMessage(
        `${e.name}: ${(e.description ?? '').slice(0, 300)}`,
        { modal: true, detail: 'Installation (consumer-id resolution, auth headers) is handled by Code Puppy itself. Use "Copy install command" and paste it into a code-puppy session.' },
        'Copy install command',
        ...(e.githubUrl ? ['Open repository'] : []),
      );
      if (action === 'Copy install command') {
        await vscode.env.clipboard.writeText(`/mcp install ${e.name}`);
        void vscode.window.showInformationMessage('Copied `/mcp install ' + e.name + '` — paste it in a Builder chat or the code-puppy CLI.');
      } else if (action === 'Open repository' && e.githubUrl) {
        void vscode.env.openExternal(vscode.Uri.parse(e.githubUrl));
      }
    }),
  ];
}
