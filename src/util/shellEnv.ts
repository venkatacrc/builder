import { execFile } from 'node:child_process';

let cached: Promise<NodeJS.ProcessEnv> | undefined;

/**
 * GUI apps on macOS (VS Code launched from the Dock) inherit a minimal PATH, so
 * `npm`, `python`, `git`, nvm/pyenv shims, etc. are missing. Resolve the user's
 * real environment by asking their login+interactive shell once, and reuse it for
 * every agent process and terminal we spawn.
 */
export function getShellEnv(): Promise<NodeJS.ProcessEnv> {
  cached ??= resolveShellEnv();
  return cached;
}

export function parseEnvOutput(output: string): Record<string, string> {
  const env: Record<string, string> = {};
  const start = output.indexOf('__BUILDER_ENV_START__');
  const body = start >= 0 ? output.slice(start + '__BUILDER_ENV_START__'.length) : output;
  for (const line of body.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

async function resolveShellEnv(): Promise<NodeJS.ProcessEnv> {
  const base = { ...process.env };
  if (process.platform === 'win32') return base;
  const shell = process.env.SHELL || '/bin/zsh';
  const output = await new Promise<string>((resolve) => {
    const child = execFile(
      shell,
      ['-ilc', 'echo __BUILDER_ENV_START__; /usr/bin/env'],
      { timeout: 15000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, TERM: 'dumb' } },
      (err, stdout) => resolve(err ? '' : stdout),
    );
    child.stdin?.end();
  });
  const fromShell = parseEnvOutput(output);
  if (!fromShell.PATH) return base;
  // Shell values win, but keep anything VS Code injected that the shell lacks.
  return { ...base, ...fromShell };
}
