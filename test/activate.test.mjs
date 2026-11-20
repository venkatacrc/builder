// Loads the real extension bundle against a mocked `vscode` module and checks activation wiring:
// no exceptions, and every command/view contributed in package.json is actually registered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const commands = new Map();
const treeProviders = new Set();
const webviewProviders = new Set();
const completionProviders = [];

function deep(name) {
  const fn = function () {};
  return new Proxy(fn, {
    get: (_t, p) => (p === 'then' ? undefined : p === Symbol.toPrimitive ? () => name : deep(`${name}.${String(p)}`)),
    apply: () => deep(`${name}()`),
    construct: () => deep(`new ${name}`),
  });
}
class EventEmitter {
  constructor() {
    this.l = new Set();
    this.event = (fn) => (this.l.add(fn), { dispose: () => this.l.delete(fn) });
  }
  fire(x) {
    for (const f of this.l) f(x);
  }
  dispose() {}
}
const disposable = () => ({ dispose() {} });
const statusItem = () => ({ show() {}, hide() {}, dispose() {}, text: '', tooltip: '', command: '' });
const uriOf = (p) => ({ fsPath: p, path: p, scheme: 'file', toString: () => `file://${p}` });

const config = { prewarm: false, 'tabCompletion.enabled': false };
const vscodeMock = {
  EventEmitter,
  Disposable: { from: (...d) => ({ dispose: () => d.forEach((x) => x?.dispose?.()) }) },
  ThemeColor: class {},
  ThemeIcon: class {},
  TreeItem: class {},
  CodeLens: class {},
  Range: class {},
  Position: class {},
  Selection: class {},
  MarkdownString: class {},
  InlineCompletionItem: class {},
  WorkspaceEdit: class {},
  OverviewRulerLane: { Left: 1 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ConfigurationTarget: { Global: 1 },
  ProgressLocation: { Notification: 15 },
  ViewColumn: { Beside: -2 },
  FileType: { Directory: 2, File: 1 },
  DiagnosticSeverity: { Error: 0, Warning: 1 },
  Uri: { file: uriOf, joinPath: (b, ...p) => uriOf(path.join(b.fsPath ?? '', ...p)), from: (o) => o, parse: (s) => uriOf(s) },
  commands: {
    registerCommand: (id, fn) => (commands.set(id, fn), disposable()),
    executeCommand: async () => {},
  },
  languages: {
    registerCodeLensProvider: () => disposable(),
    registerInlineCompletionItemProvider: (...a) => (completionProviders.push(a), disposable()),
    getDiagnostics: () => [],
  },
  workspace: {
    workspaceFolders: undefined,
    textDocuments: [],
    getConfiguration: () => ({ get: (k, d) => (k in config ? config[k] : d), update: async () => {} }),
    registerTextDocumentContentProvider: () => disposable(),
    onDidChangeTextDocument: () => disposable(),
    onDidChangeConfiguration: () => disposable(),
    onDidChangeWorkspaceFolders: () => disposable(),
    isTrusted: true,
    onDidGrantWorkspaceTrust: () => disposable(),
    asRelativePath: (p) => String(p?.fsPath ?? p),
    fs: {},
  },
  window: {
    visibleTextEditors: [],
    activeTextEditor: undefined,
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createTextEditorDecorationType: () => disposable(),
    createStatusBarItem: statusItem,
    onDidChangeVisibleTextEditors: () => disposable(),
    onDidChangeActiveTextEditor: () => disposable(),
    registerWebviewViewProvider: (id) => (webviewProviders.add(id), disposable()),
    registerTreeDataProvider: (id) => (treeProviders.add(id), disposable()),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    createTerminal: () => deep('terminal'),
  },
  env: { clipboard: { writeText: async () => {} } },
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.call(this, request, ...rest);
};

function makeCtx() {
  const store = () => {
    const m = new Map();
    return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => void m.set(k, v) };
  };
  return {
    subscriptions: [],
    extensionPath: root,
    extensionUri: uriOf(root),
    globalState: store(),
    workspaceState: store(),
  };
}

test('activates without throwing and registers everything the manifest contributes', async () => {
  const ext = require(path.join(root, 'dist/extension.js'));
  const ctx = makeCtx();
  ext.activate(ctx);

  const declared = manifest.contributes.commands.map((c) => c.command);
  const missing = declared.filter((c) => !commands.has(c));
  assert.deepEqual(missing, [], `commands declared in package.json but not registered: ${missing}`);

  for (const k of manifest.contributes.keybindings) assert.ok(commands.has(k.command) || declared.includes(k.command), `keybinding → ${k.command}`);

  const views = manifest.contributes.views.builder;
  for (const v of views) {
    const known = v.type === 'webview' ? webviewProviders.has(v.id) : treeProviders.has(v.id);
    assert.ok(known, `view ${v.id} has a registered provider`);
  }
  assert.ok(completionProviders.length === 1, 'inline completion provider registered');

  // every menu command exists
  const menuCmds = Object.values(manifest.contributes.menus).flat().map((m) => m.command);
  for (const c of menuCmds) assert.ok(declared.includes(c), `menu references declared command ${c}`);

  for (const s of ctx.subscriptions) s?.dispose?.();
  ext.deactivate();
});
