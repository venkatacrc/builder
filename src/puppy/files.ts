/**
 * Everything Builder needs to know about a local Code Puppy install, read straight
 * from its files. No `vscode` dependency (shared with tests / scripts).
 *
 * Secrets: puppy.cfg contains `puppy_token`. We only ever read the keys we need
 * (model, default_agent) and never log or forward the rest.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------- locations ---

export function defaultConfigDir(override?: string): string {
  if (override) return expandHome(override);
  return path.join(os.homedir(), '.code_puppy');
}

export function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export interface PuppyInstall {
  /** Absolute path to the `code-puppy` entry point. */
  executable: string;
  /** venv python next to the executable (needed by the launcher / catalog), if any. */
  python?: string;
}

export function locateCodePuppy(configured: string | undefined, env: NodeJS.ProcessEnv): PuppyInstall | undefined {
  const candidates: string[] = [];
  if (configured) candidates.push(expandHome(configured));
  candidates.push(path.join(os.homedir(), '.code-puppy-venv', 'bin', 'code-puppy'));
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'code-puppy'));
  }
  candidates.push('/opt/homebrew/bin/code-puppy', '/usr/local/bin/code-puppy', path.join(os.homedir(), '.local', 'bin', 'code-puppy'));
  for (const c of candidates) {
    if (isExecutable(c)) {
      const real = safeRealpath(c);
      const python = [path.join(path.dirname(c), 'python'), path.join(path.dirname(real), 'python')].find(isExecutable);
      return { executable: c, python };
    }
  }
  // Last resort: ask a login shell (handles aliases that point at the venv).
  try {
    const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'command -v code-puppy'], { timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /(\/[^\s]*code-puppy)\s*$/m.exec(out.replace(/aliased to /g, ''));
    if (m && isExecutable(m[1])) {
      const python = path.join(path.dirname(m[1]), 'python');
      return { executable: m[1], python: isExecutable(python) ? python : undefined };
    }
  } catch {
    /* not found */
  }
  return undefined;
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// ------------------------------------------------------------------- config ---

/** Tiny INI reader for the handful of non-secret keys we care about. */
export function readPuppyCfg(configDir: string, keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    const text = fs.readFileSync(path.join(configDir, 'puppy.cfg'), 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && keys.includes(m[1])) result[m[1]] = m[2];
    }
  } catch {
    /* no config */
  }
  return result;
}

export interface ModelInfo {
  id: string;
  type?: string;
  upstreamName?: string;
}

/** Models from the user's models.json (the live list comes from ACP once a session exists). */
export function readUserModels(configDir: string): ModelInfo[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'models.json'), 'utf8'));
    return Object.entries<any>(raw).map(([id, v]) => ({ id, type: v?.type, upstreamName: v?.name }));
  } catch {
    return [];
  }
}

export interface Catalog {
  agents: Record<string, { display: string; description: string }>;
  models: string[];
  defaultAgent: string | null;
  defaultModel: string | null;
}

export const FALLBACK_AGENTS: Catalog['agents'] = {
  'code-puppy': { display: 'Code Puppy', description: 'General coding agent' },
};

// ----------------------------------------------------------------- sessions ---

export type SessionSource = 'builder' | 'cli';

export interface SessionSummary {
  /** For builder sessions: the ACP session id. For cli sessions: the autosave stem. */
  id: string;
  source: SessionSource;
  title: string;
  subtitle?: string;
  cwd?: string;
  updatedAt: number; // epoch ms
  messageCount?: number;
  /** Absolute path to the session JSON envelope. */
  file: string;
}

const safeName = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_');

export function acpSessionsDir(configDir: string): string {
  return path.join(configDir, 'autosaves', 'acp');
}

export function cliSessionsDir(configDir: string): string {
  return path.join(configDir, 'autosaves');
}

export function listBuilderSessions(configDir: string, titles: Record<string, string> = {}): SessionSummary[] {
  const dir = acpSessionsDir(configDir);
  const out: SessionSummary[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (!n.endsWith('_acp.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      const id: string | undefined = meta.session_id;
      if (!id) continue;
      const file = path.join(dir, `${safeName(id)}.json`);
      if (!fs.existsSync(file)) continue;
      const st = fs.statSync(file);
      let title = titles[id];
      if (!title) {
        try {
          const sidecar = JSON.parse(fs.readFileSync(path.join(dir, `${safeName(id)}_meta.json`), 'utf8'));
          title = sidecar.title;
        } catch {
          /* ignore */
        }
      }
      title ||= firstUserPrompt(file) || id;
      out.push({
        id,
        source: 'builder',
        title,
        cwd: meta.cwd ?? undefined,
        updatedAt: meta.updated_at ? Date.parse(meta.updated_at) || st.mtimeMs : st.mtimeMs,
        file,
      });
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function listCliSessions(configDir: string): SessionSummary[] {
  const dir = cliSessionsDir(configDir);
  const out: SessionSummary[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (!n.endsWith('_meta.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      const stem = n.replace(/_meta\.json$/, '');
      const file = path.join(dir, `${stem}.json`);
      if (!fs.existsSync(file)) continue;
      out.push({
        id: stem,
        source: 'cli',
        title: meta.title || meta.session_name || stem,
        subtitle: meta.subtitle,
        cwd: meta.scope_key || undefined,
        updatedAt: Date.parse(meta.timestamp) || fs.statSync(file).mtimeMs,
        messageCount: meta.message_count,
        file,
      });
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** First user prompt text of a session envelope (reads at most the first 256 KB). */
export function firstUserPrompt(file: string): string | undefined {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf8', 0, n);
    const m = /"part_kind"\s*:\s*"user-prompt"/.exec(head);
    // The envelope puts "content" before "part_kind" inside each part.
    const before = m ? head.slice(Math.max(0, m.index - 4000), m.index) : '';
    const c = [...before.matchAll(/"content"\s*:\s*("(?:[^"\\]|\\.)*")/g)].pop();
    if (c) {
      const text = JSON.parse(c[1]) as string;
      const cleaned = stripBuilderContext(text).replace(/\s+/g, ' ').trim();
      return cleaned.slice(0, 80) || undefined;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export interface TranscriptEntry {
  kind: 'user' | 'assistant' | 'tool';
  text: string;
}

/** Read the visible conversation out of a session envelope (no agent process needed). */
export function readTranscript(file: string, maxEntries = 400): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  try {
    const env = JSON.parse(fs.readFileSync(file, 'utf8'));
    const messages: any[] = Array.isArray(env?.messages) ? env.messages : [];
    for (const m of messages) {
      for (const p of m?.parts ?? []) {
        switch (p?.part_kind) {
          case 'user-prompt': {
            const c = typeof p.content === 'string' ? p.content : Array.isArray(p.content) ? p.content.filter((x: unknown) => typeof x === 'string').join('\n') : '';
            const t = stripBuilderContext(c);
            if (t) out.push({ kind: 'user', text: t });
            break;
          }
          case 'text':
            if (typeof p.content === 'string' && p.content.trim()) out.push({ kind: 'assistant', text: p.content });
            break;
          case 'tool-call':
            out.push({ kind: 'tool', text: String(p.tool_name ?? 'tool') });
            break;
          default:
            break;
        }
      }
    }
  } catch {
    /* unreadable: empty transcript */
  }
  return out.length > maxEntries ? out.slice(out.length - maxEntries) : out;
}

/** Remove the editor-context header / <context> blocks Builder adds to prompts. */
export function stripBuilderContext(text: string): string {
  let t = text.replace(/^\[Editor context\][^\n]*(?:\n[^\n]+)*\n*/, '');
  t = t.replace(/<context uri=[\s\S]*?<\/context>\s*/g, '');
  t = t.replace(/\[Referenced resource:[^\]]*\]\s*/g, '');
  return t.trim();
}

/**
 * Make a terminal (CLI) autosave resumable from the editor by copying its envelope into
 * the ACP session directory (code-puppy keeps ACP threads separate so they never pollute the
 * CLI `/resume` picker). Returns the new ACP session id.
 */
export function importCliSession(configDir: string, s: SessionSummary, fallbackCwd: string): string {
  const dir = acpSessionsDir(configDir);
  fs.mkdirSync(dir, { recursive: true });
  const id = `sess_imp_${safeName(s.id).slice(-24)}`;
  const target = path.join(dir, `${safeName(id)}.json`);
  fs.copyFileSync(s.file, target);
  const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : fallbackCwd;
  const tmp = path.join(dir, `${safeName(id)}_acp.json.tmp`);
  fs.writeFileSync(
    tmp,
    JSON.stringify({ session_id: id, cwd, additional_directories: null, updated_at: new Date().toISOString() }, null, 2),
  );
  fs.renameSync(tmp, path.join(dir, `${safeName(id)}_acp.json`));
  return id;
}

export function deleteBuilderSession(configDir: string, id: string): void {
  const dir = acpSessionsDir(configDir);
  const stem = safeName(id);
  for (const f of [`${stem}.json`, `${stem}.pkl`, `${stem}_meta.json`, `${stem}_acp.json`]) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      /* ignore */
    }
  }
}

export function builderSessionFile(configDir: string, id: string): string {
  return path.join(acpSessionsDir(configDir), `${safeName(id)}.json`);
}

// ---------------------------------------------------------------------- mcp ---

export interface McpServer {
  name: string;
  type: string;
  url?: string;
  command?: string;
  args?: string[];
  enabled: boolean;
  /** Where the definition lives. */
  source: 'mcp_servers.json' | 'mcp_registry.json';
  raw: any;
}

export function mcpServersFile(configDir: string): string {
  return path.join(configDir, 'mcp_servers.json');
}
export function mcpRegistryFile(configDir: string): string {
  return path.join(configDir, 'mcp_registry.json');
}

function readJson(file: string): any | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.builder-tmp`;
  if (fs.existsSync(file) && !fs.existsSync(`${file}.builder-bak`)) fs.copyFileSync(file, `${file}.builder-bak`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function listMcpServers(configDir: string): McpServer[] {
  const servers = new Map<string, McpServer>();
  const registry = readJson(mcpRegistryFile(configDir)) ?? {};
  for (const [id, v] of Object.entries<any>(registry)) {
    const cfg = v?.config ?? {};
    servers.set(v?.name ?? id, {
      name: v?.name ?? id,
      type: v?.type ?? cfg.type ?? 'unknown',
      url: cfg.url,
      command: cfg.command,
      args: cfg.args,
      enabled: v?.enabled !== false,
      source: 'mcp_registry.json',
      raw: v,
    });
  }
  const file = readJson(mcpServersFile(configDir))?.mcp_servers ?? {};
  for (const [name, cfg] of Object.entries<any>(file)) {
    if (servers.has(name)) continue;
    servers.set(name, {
      name,
      type: cfg?.type ?? 'unknown',
      url: cfg?.url,
      command: cfg?.command,
      args: cfg?.args,
      enabled: cfg?.enabled !== false,
      source: 'mcp_servers.json',
      raw: cfg,
    });
  }
  return [...servers.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function setMcpEnabled(configDir: string, name: string, enabled: boolean): void {
  const regFile = mcpRegistryFile(configDir);
  const registry = readJson(regFile);
  if (registry) {
    for (const [id, v] of Object.entries<any>(registry)) {
      if ((v?.name ?? id) === name) {
        v.enabled = enabled;
        writeJsonAtomic(regFile, registry);
        return;
      }
    }
  }
  const file = mcpServersFile(configDir);
  const data = readJson(file) ?? { mcp_servers: {} };
  if (data.mcp_servers?.[name]) {
    data.mcp_servers[name].enabled = enabled;
    writeJsonAtomic(file, data);
    return;
  }
  throw new Error(`MCP server '${name}' not found`);
}

export function addMcpServer(configDir: string, name: string, cfg: Record<string, unknown>): void {
  const file = mcpServersFile(configDir);
  const data = readJson(file) ?? { mcp_servers: {} };
  data.mcp_servers ??= {};
  if (data.mcp_servers[name]) throw new Error(`MCP server '${name}' already exists`);
  data.mcp_servers[name] = { name, ...cfg };
  writeJsonAtomic(file, data);
}

export function removeMcpServer(configDir: string, name: string): void {
  const file = mcpServersFile(configDir);
  const data = readJson(file);
  if (data?.mcp_servers?.[name]) {
    delete data.mcp_servers[name];
    writeJsonAtomic(file, data);
  }
  const regFile = mcpRegistryFile(configDir);
  const registry = readJson(regFile);
  if (registry) {
    let changed = false;
    for (const [id, v] of Object.entries<any>(registry)) {
      if ((v?.name ?? id) === name) {
        delete registry[id];
        changed = true;
      }
    }
    if (changed) writeJsonAtomic(regFile, registry);
  }
}

export interface MarketplaceEntry {
  name: string;
  key?: string;
  description?: string;
  githubUrl?: string;
  tags: string[];
  modified?: string;
}

export function readMarketplace(configDir: string): MarketplaceEntry[] {
  const raw = readJson(path.join(configDir, 'walmart_mcp_marketplace_cache.json'));
  const data: any[] = Array.isArray(raw?.data) ? raw.data : [];
  return data
    .map((d) => ({
      name: String(d.name ?? ''),
      key: d.key,
      description: d.description,
      githubUrl: d.githubUrl,
      tags: Array.isArray(d.tags) ? d.tags : [],
      modified: d.modified,
    }))
    .filter((d) => d.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}
