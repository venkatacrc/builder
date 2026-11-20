// Bundles the extension host code and the webview script.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');

mkdirSync('dist', { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const common = { bundle: true, sourcemap: true, logLevel: 'info', minify: false };

const targets = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  },
  // Pure-protocol modules, bundled separately so the node:test suite and the
  // real-agent integration script can import them without `vscode`.
  {
    ...common,
    entryPoints: { rpc: 'src/acp/rpc.ts', agent: 'src/acp/agent.ts', shellEnv: 'src/util/shellEnv.ts', puppyFiles: 'src/puppy/files.ts', text: 'src/inline/text.ts' },
    outdir: 'dist/lib',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
  },
];

function copyStatic() {
  cpSync('src/webview/webview.css', 'dist/webview.css');
  cpSync('python', 'dist/python', { recursive: true });
}

if (watch) {
  for (const t of targets) {
    const ctx = await esbuild.context(t);
    await ctx.watch();
  }
  copyStatic();
  console.log('watching...');
} else {
  await Promise.all(targets.map((t) => esbuild.build(t)));
  copyStatic();
}
