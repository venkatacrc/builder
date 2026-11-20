# Builder: guide to experimenting and improving

This guide explains how Builder works, how to run and debug it (both the Builder
IDE fork and the extension), and a list of concrete experiments, each with a way
to measure whether it helped.

## 1. Architecture

```
Builder IDE window (or VS Code with the extension)
 ├─ Webview (src/webview)           chat UI on the right: header, messages, composer
 ├─ ChatBridge (src/chat/ChatView)  webview <-> host messages
 ├─ ChatManager / ChatSession       one visible chat; History reopens older ones
 │     ├─ ContextResolver           @file/@folder/selection -> ACP content blocks
 │     ├─ ChangeTracker             applies agent writes, Keep/Undo/Diff review
 │     └─ TerminalManager           terminal/* requests -> visible terminals
 ├─ AgentPool / AgentRuntime        spawns and pre-warms agent processes
 ├─ UtilityAgent                    no-tools process for Tab and Cmd+K
 └─ Left "Builder" view: Changes, History, MCP (read ~/.code_puppy directly)

the chat  ──stdio JSON-RPC (ACP)──>  python builder_launcher.py  (code-puppy --acp)
```

Key points:

- **One chat, one agent.** Builder shows a single conversation. New chat and
  opening an old one from History replace it (it stays saved). Every process runs
  the same code-puppy agent, `builder.agent` (default `code-puppy`). The ACP
  `model` option is process-global, so each chat owns its process.
- **The launcher** (`python/builder_launcher.py`) runs inside code-puppy's venv
  and patches four things before starting ACP:
  1. `set_model_name` becomes in-memory, so dropdown changes do not rewrite
     `puppy.cfg` and do not affect your terminal CLI.
  2. Session autosave is a no-op for the agent manager, because Builder owns
     persistence in `autosaves/acp/`.
  3. With `BUILDER_UTILITY=1` it swaps in a minimal system prompt for fast
     completions.
  4. `BUILDER_AGENT` pins the agent the process starts with, so `default_agent`
     in `puppy.cfg` and code-puppy's per-terminal agent cache don't leak in.
  Turn it off with `builder.useLauncher=false` to run stock `code-puppy --acp`.
- **Warm pool.** Agent start is slow (12 to 60 s cold, about 13 s warm). One
  spare process is started when the chat view first opens; a new chat claims it.
  Idle chats are stopped by the reaper and resumed with `session/load`.
- **Agent fallback.** Without the launcher, Builder switches a fresh process to
  `builder.agent` by sending `/agent X` and then `session/load` on the same
  session id.
- **Edits go through VS Code.** The client advertises `fs.readTextFile` and
  `fs.writeTextFile`, so reads see unsaved buffers and every write is recorded
  by `ChangeTracker` with the original text.
- **Sessions are shared.** ACP sessions live in `autosaves/acp/`. CLI autosaves
  (`autosaves/*.json`) are imported by copying the envelope into the ACP
  directory. "Resume in CLI" runs `code-puppy --resume <file>`.
- **Wire quirk.** code-puppy prints terminal escape sequences before its first
  JSON line. `extractJsonLine` in `src/acp/rpc.ts` strips them.

## 2. Run and debug

```bash
npm install
npm run watch
```

Press F5 and pick "Run Builder extension". In the dev host:

- **Builder: Diagnose Setup** checks binary, config dir, shell env, handshake.
- Output panel, channel **Builder**, shows logs. Set `builder.log.protocol` to
  `true` to see every JSON-RPC message.
- Webview devtools: command palette, "Developer: Open Webview Developer Tools".

Testing:

| Command | What it covers | Needs real puppy |
| --- | --- | --- |
| `npm test` | RPC framing, file parsers, text helpers, activation with a mocked `vscode`, manifest cross-checks | no |
| `node test/integration/real-agent.mjs` | handshake, models, streaming, fs write, session persist and resume | yes |
| `node test/integration/utility-agent.mjs [model]` | utility agent latency for completion and edit | yes |
| `node test/integration/agent-switch.mjs` | `/agent` switch plus `session/load` | yes |

The integration scripts spend model tokens and take minutes on a cold start.

Not covered by automated tests: the real VS Code UI (webview rendering, CodeLens,
keybindings). The activation test only checks that `activate()` registers every
command and view that `package.json` declares. Click through the first-run
checklist below after installing.

### First-run checklist

1. Run Diagnose Setup; all rows green.
2. Open the Builder panel on the right, wait for the status to say ready, send "hello".
3. Change the model picker, send another message, confirm in the CLI that
   `puppy.cfg` still has your original model.
4. Ask it to create a file; confirm Keep/Undo CodeLens and the Changes view
   (left Builder icon).
5. Ask it to run `ls`; confirm a Builder terminal appears and a permission prompt shows.
6. Select code, press `Cmd+K`, give an instruction, confirm the diff.
7. Click the History (clock) button, open a terminal session, then use
   "Resume in CLI" from the left History view.
8. Open MCP view, toggle a server.

## 3. Experiments

Each experiment lists the idea, where to change code, and how to measure.

### 3.1 Cut cold-start time (highest value)

- Idea: most of the 12 to 60 s is Python import and agent construction.
- Try: set `PYTHONPROFILEIMPORTTIME=1` in `AgentRuntime.spawnProcess`, run
  `python -X importtime`, and look for heavy imports in code-puppy. Defer or lazy
  load them in `builder_launcher.py` by pre-seeding `sys.modules` stubs for
  unused features.
- Try: raise the pool to two spares for power users; compare memory.
- Measure: time from `spawn` to the `initialize` response and then to the first
  `session/new` result. Both are logged at protocol level.

### 3.2 Faster Tab and Cmd+K

- Today each request is one ACP session on a no-tools process: 1.3 to 2.2 s with
  `claude-haiku-5-5`.
- Try other models via `builder.tabCompletion.model`, and shorten context with
  `maxPrefixChars` and `maxSuffixChars`.
- Bigger change: bypass ACP and call the model endpoint directly from the
  extension (read the provider settings from `models.json`). That removes
  session creation overhead but means Builder must handle auth, so it conflicts
  with the "no secrets" rule. Decide deliberately.
- Measure: `node test/integration/utility-agent.mjs <model>` p50 and p95, plus
  acceptance rate (add a counter in `TabCompletion.ts`).

### 3.3 Per-hunk review

- Today Keep/Undo is per file. `ChangeTracker` already stores the original text
  and a minimal diff via `trimCommon`.
- Use `diff.structuredPatch(original, current)` to split hunks, show one CodeLens
  per hunk, and implement partial revert by applying the inverse of one hunk with
  a `WorkspaceEdit`. Re-diff after every edit.
- Measure: manual scenarios with three hunks, accept one, reject two.

### 3.4 Show what the agent wants to do in permission prompts

- Today `session/request_permission` carries a title only. The launcher could
  attach the command or a diff preview (the ACP spec allows `content` on tool
  calls). Patch the ACP permission path in code-puppy's launcher, then render it
  in `ChatSession.requestPermission` and the webview.

### 3.5 MCP binding UI

- Real finding: MCP servers are bound per agent in code-puppy ("registered but not
  bound to agent X, run `/mcp` to bind"). The MCP view toggles `enabled` in
  `mcp_registry.json`, but a server also has to be bound for the active agent.
- Try: in the launcher, auto-bind every enabled server to the current agent, or
  add a per-agent checkbox list to the MCP view backed by the same file code-puppy
  uses (see `/mcp bind` in the code-puppy source).
- Marketplace install is currently "copy `/mcp install <name>`" because the
  install flow is interactive. Replace it by calling the install function from
  the launcher.

### 3.6 Codebase awareness

- `@file` and `@folder` are explicit. Add `@codebase`: build a local embedding or
  ripgrep-based index in the extension host and inject the top results as
  context blocks. Start with ripgrep plus symbol search (`vscode.executeWorkspaceSymbolProvider`).
- Measure on 10 real questions: did the right file reach the prompt?

### 3.7 Modes: Ask, Plan, Agent

- Builder deliberately runs one agent. If you want modes later, keep the single
  agent and vary the instructions instead: Ask uses a no-tools process, Plan
  prefixes the prompt with "plan only, don't edit", Agent is today's behavior.

### 3.8 Checkpoints and rewind

- On each user turn, snapshot `ChangeTracker` records (or `git stash create`).
  Add "Restore to before this message".

### 3.9 Usage and cost visibility

- `session/prompt` results may carry usage data. Show tokens per turn and a
  running total in the chat footer.

### 3.10 Rules and project memory

- Detect `AGENTS.md`, `.cursor/rules`, or `.code_puppy` rule files and attach them
  in `ContextResolver.editorContextBlock`. Check what code-puppy already loads
  to avoid duplicates.

### 3.11 Evaluate model and agent choices

- Write a small task set (e.g. 10 repo tasks with a verifying command).
  Use `AcpAgent` from a script (see `test/integration/real-agent.mjs`) to run each
  task for every model in `models.json`, then record pass/fail, time, tokens.
  This tells you which model to set as default and which for Tab.

### 3.12 Builder IDE: the Code-OSS fork

Everything lives in `ide/` and is driven by `ide/fork.sh`:

| Piece | What it does |
| --- | --- |
| `VSCODE_VERSION` | the pinned upstream tag (`1.147.0`), shallow-cloned into `../builder-ide/vscode` (outside this repo, so TypeScript doesn't pick up this repo's `node_modules/@types`; override with `BUILDER_IDE_HOME`) |
| `patches/0001-builder.patch` | the only core changes (below) |
| `product.overrides.json` | branding merged into `product.json`: name Builder, `~/.builder` data folder, bundle id `com.walmart.builder` |
| `branding/` | the app icon (`builder-icon.svg`, rendered to `builder.icns`) |
| `.tools/` | Node and pnpm versions the fork needs, downloaded on demand |

Core patch, kept deliberately small:

1. `chat.disableAIFeatures` defaults to `true`. This is VS Code's own switch that
   hides Copilot Chat, agent sessions and inline suggestions, so Builder is the
   only assistant.
2. `chat.copilotCliCommand.enabled` defaults to `false` (no `copilot` command in
   terminals).
3. The packaging step no longer builds or ships the Copilot Chat extension.
4. Native module headers come from `artifacts.electronjs.org`, because the
   Walmart proxy blocks `electronjs.org`.
5. With AI features disabled, the secondary side bar restores
   `workbench.view.extension.builder` by default (`layout.ts`). Otherwise it
   would restore the empty Copilot chat container and hide itself, and Builder
   would not show on first launch.
6. The shell environment timeout defaults to 30 seconds instead of 10, because
   corporate zsh setups often take longer than 10 seconds to start.

Builder itself is not patched into core: `ide/fork.sh sync` builds this repo and
copies `package.json`, `dist/` and `media/` into `../builder-ide/vscode/extensions/builder`,
where the build packages it as a built-in extension. If you rename Builder's view
container in `package.json`, update the id in `layout.ts` too.

Builder declares limited support for untrusted workspaces. In Restricted Mode the
chat still shows (with a Trust button), but no code-puppy process starts until
the folder is trusted, and workspace values of the settings that choose what runs
(`codePuppyPath`, `configDir`, `useLauncher`, `agent`, `autoApprove`,
`delegateTerminal`) are ignored. Builder is never disabled, so its webview doesn't
have to appear mid-session; with `supported: false`, VS Code enables the extension
on trust and the chat view can stay blank until a window reload.

Workflow:

- Change Builder: edit `src/`, then `ide/fork.sh sync` and either `ide/fork.sh dev`
  or `ide/fork.sh package`.
- Change core: edit files under `../builder-ide/vscode`, then `ide/fork.sh diff` to save them
  into the patch. Keep the patch small; every line is a future merge conflict.
- Upgrade VS Code: bump `ide/VSCODE_VERSION`, delete `../builder-ide/vscode`, run
  `ide/fork.sh setup`. If the patch no longer applies, fix it by hand and run
  `ide/fork.sh diff`.

Network notes for the Walmart proxy: the install skips Microsoft's local-model
runtime (`FOUNDRY_LOCAL_SKIP_INSTALL=1`), which downloads from NuGet outside the
proxy, and the build sets `NODE_USE_ENV_PROXY=1` so Node's `fetch` uses
`https_proxy`. npm packages come from your configured registry
(`npme.walmart.com`). There is no extension marketplace: Open VSX is blocked, and
the Microsoft marketplace is licensed for Microsoft products only. Install
extensions from `.vsix` files.

Ideas for the fork, now that it exists:

- Remove the dormant Copilot SDK runtime from the app (it is a core production
  dependency today, so this needs a core patch).
- Native inline diff for agent edits using the editor's diff decorations instead
  of CodeLens.
- First-run walkthrough for Builder (Welcome page contribution) that runs
  Diagnose Setup.
- Code signing and notarization if you share the app with your team; unsigned
  builds need right-click, Open the first time.

## 4. Configuration reference

See the settings table in the `README.md`. Files Builder reads:

| File in `~/.code_puppy` | Use |
| --- | --- |
| `puppy.cfg` | default model and agent (whitelisted keys only) |
| `models.json` | model dropdown |
| `mcp_servers.json`, `mcp_registry.json` | MCP view |
| `walmart_mcp_marketplace_cache.json` | marketplace browse |
| `autosaves/*.json` and `_meta.json` | CLI sessions (import) |
| `autosaves/acp/` | Builder sessions (read/write) |

Builder writes only to `autosaves/acp/` and, when you use the MCP view, to the MCP
files (a `.builder-bak` backup is kept).

## 5. Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| "code-puppy not found" | GUI-launched VS Code has a small PATH. Set `builder.codePuppyPath`. Builder also loads your login shell env (`$SHELL -ilc env`). |
| Status stays "starting" a long time | Cold start. Wait up to 60 s; the next chats are faster thanks to the pool. Check the Builder output channel. |
| Model dropdown empty | Falls back to `models.json`. Check Diagnose Setup and `builder.configDir`. |
| Model change shows in CLI | `builder.useLauncher` is false or `persistModelSelection` is true. |
| `Cmd+K` does nothing or breaks chords | Set `builder.inlineEdit.useCmdK=false` and use `Cmd+Alt+K`. |
| MCP tool not available in chat | Server enabled but not bound to the agent. See 3.5 or run `/mcp` in the CLI once. |
| Edits seem applied twice | Check Changes view; Undo restores the original text recorded for that file. |
| Odd JSON parse error at start | Turn on `builder.log.protocol` and check for output other than JSON lines. |

## 6. Known limits

- The protocol layer was tested against a real code-puppy; the UI with a mocked
  `vscode` and by launching the packaged Builder IDE.
- Builder IDE is unsigned; macOS asks you to confirm the first launch. It still
  contains the (disabled) Copilot SDK runtime from upstream.
- Cold start is slow; pre-warming hides it only for the first chat.
- Review is per file, not per hunk.
- Permission prompts show a title, not the command or diff.
- MCP binding is per agent and has no UI yet.
- `Cmd+K` replaces VS Code's chord prefix by default.
- Tab autocomplete is off by default because every suggestion costs a model call.
- Drag-and-drop attach is not implemented; use `@` or the attach buttons.
- A CLI session imported into Builder is copied, so later CLI edits to it do not
  sync back.

## 7. Suggested order of work

1. Run the first-run checklist and fix what you hit.
2. 3.1 startup time and 3.5 MCP binding (they affect daily use most).
3. 3.4 permission previews and 3.3 per-hunk review (trust).
4. 3.11 evals to choose models, then 3.2 for Tab.
5. 3.12 fork ideas once the daily flow feels right.
