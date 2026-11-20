# Builder

A Cursor-style AI editor powered by your locally installed **code-puppy**
(Walmart Puppy). It comes in two forms built from this repo:

- **Builder IDE**: a Code-OSS (VS Code open source) fork with Builder built in and
  Copilot removed. One assistant, one chat, on the right. Source and build
  scripts live in `ide/`.
- **Builder extension**: the same assistant as a `.vsix` for regular VS Code.

Builder talks to `code-puppy --acp` (Agent Client Protocol over stdio), so it
reuses your code-puppy models, MCP servers, credentials and sessions. It stores
no secrets.

> Guide for experimenting and improving it: `docs/GUIDE.md`

## Features

| Feature | Where |
| --- | --- |
| Chat with streaming, thoughts, tool calls | Builder panel on the right, `Cmd+L` |
| One code-puppy agent (`builder.agent`, default `code-puppy`) | Fixed, no agent picker |
| Model picker (from `models.json`) | Chat composer |
| New chat and History (Builder and terminal sessions) | Chat header |
| Diff review: Keep / Undo / Diff per file | CodeLens, Builder tools view on the left |
| `@file`, `@folder`, selection, problems, images | Chat composer, `Cmd+Shift+L` |
| Inline edit | `Cmd+K` (or `Cmd+Alt+K`) |
| Tab autocomplete (off by default) | Status bar toggle |
| Shell commands in visible terminals, approvals, Auto toggle | Chat |
| MCP servers: enable/disable/add/remove, marketplace browse | Builder tools view on the left |

## Builder IDE (the fork)

Requirements: macOS, Xcode command line tools, about 15 GB of disk in the folder
next to this repo (`../builder-ide`, or set `BUILDER_IDE_HOME`), network
access to GitHub, nodejs.org, artifacts.electronjs.org and your npm registry.
Node and pnpm are downloaded into `ide/.tools`; your global setup is untouched.

```bash
npm install                 # Builder extension dependencies
ide/fork.sh setup           # clone VS Code 1.147.0 into ../builder-ide, patch, brand, install deps (~20 min)
ide/fork.sh package         # build ../builder-ide/VSCode-darwin-arm64/Builder.app
ide/fork.sh install         # copy it to /Applications
```

`ide/fork.sh dev` runs the fork from source, and `ide/fork.sh sync` refreshes the
built-in Builder extension after you change it. See `docs/GUIDE.md` for how the
fork is put together.

Builder IDE keeps its own settings and extensions (`~/.builder`,
`~/Library/Application Support/Builder`), separate from VS Code. Like stock
Code-OSS it has no extension marketplace (Open VSX is blocked on the Walmart
network); install extensions from `.vsix` files (Extensions view, "...", Install
from VSIX).

## Builder extension (regular VS Code)

Requirements: macOS, a recent VS Code (tested with 1.147), Node 18+ (build only), code-puppy installed
(`curl -skSL https://puppy.walmart.com/api/releases/setup_v2 | bash`).

```bash
npm install
npm run package                              # produces builder.vsix
code --install-extension builder.vsix --force
```

Then run **Builder: Diagnose Setup** from the command palette. It checks the
code-puppy binary, the config directory, the shell environment and the ACP
handshake.

## Develop

```bash
npm install
npm run watch        # rebuild on change
# press F5 ("Run Builder extension") to open an Extension Development Host
npm test             # unit + activation tests
npm run test:integration   # talks to your real code-puppy (slow, uses a model)
```

## Settings (prefix `builder.`)

| Setting | Default | Meaning |
| --- | --- | --- |
| `codePuppyPath` | auto | Path to the `code-puppy` binary |
| `configDir` | `~/.code_puppy` | code-puppy config and sessions directory |
| `useLauncher` | true | Use `python/builder_launcher.py` (see guide) |
| `persistModelSelection` | false | If true, model changes also write `puppy.cfg` |
| `agent` | `code-puppy` | The one code-puppy agent Builder uses |
| `defaultModel` | empty | Model for new chats (empty: last used) |
| `prewarm` | true | Keep one spare agent process ready |
| `maxAgentProcesses` | 4 | Concurrent agent processes |
| `idleTimeoutMinutes` | 30 | Idle chats are stopped and resumed on demand |
| `autoApprove` | false | Skip permission prompts (yolo) |
| `delegateTerminal` | true | Show agent shell commands in VS Code terminals |
| `includeActiveEditorContext` | true | Attach the active file and selection |
| `inlineEdit.useCmdK` | true | Bind `Cmd+K` (replaces VS Code chord prefix) |
| `inlineEdit.model` / `tabCompletion.model` | fast model | Model for utility requests |
| `tabCompletion.enabled` | false | Enable Tab autocomplete |
| `log.protocol` | false | Log raw ACP traffic to the Builder output channel |

## Safety notes

- The agent edits files through VS Code, so every change is tracked and
  undoable. Writes outside the workspace require a modal confirmation.
- Permission requests are shown in the chat. `autoApprove` turns that off; use it
  only in throw-away workspaces.
- Builder reads only whitelisted keys of `puppy.cfg` and never reads token files.
- Tab autocomplete and `Cmd+K` use a separate no-tools agent process that cannot
  touch files or run commands.

## Known limits

See `docs/GUIDE.md` (section "Known limits"). In short: cold start of an agent
process is 12 to 60 s (mitigated by pre-warming), review is per file not per
hunk, and MCP servers are bound per agent in code-puppy.
