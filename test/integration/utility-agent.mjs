// Verifies the tool-less "utility" agent used for Tab autocomplete / Cmd+K, plus /agent switching.
//   node test/integration/utility-agent.mjs [fast-model-id]
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { AcpAgent } = require(path.join(root, 'dist/lib/agent.js'));
const { getShellEnv } = require(path.join(root, 'dist/lib/shellEnv.js'));
const F = require(path.join(root, 'dist/lib/puppyFiles.js'));
const { buildCompletionPrompt, cleanCompletion, buildInlinePrompt, extractCode } = require(path.join(root, 'dist/lib/text.js'));

const fastModel = process.argv[2];
const env = { ...(await getShellEnv()), PYTHONUNBUFFERED: '1', BUILDER_PERSIST_MODEL: '0', BUILDER_UTILITY: '1' };
const install = F.locateCodePuppy(undefined, env);
const text = new Map();
const { agent } = AcpAgent.spawn(
  { command: install.python, args: [path.join(root, 'dist/python/builder_launcher.py'), '--acp', '--no-tools'], cwd: os.tmpdir(), env },
  {
    onUpdate: (sid, u) => u.sessionUpdate === 'agent_message_chunk' && text.set(sid, (text.get(sid) ?? '') + (u.content?.text ?? '')),
    requestPermission: async () => ({ outcome: 'cancelled' }),
  },
);
let failed = 0;
const check = (c, n, d = '') => {
  console.log(`  ${c ? '✔' : '✖'} ${n} ${d}`);
  if (!c) failed++;
};

async function ask(prompt) {
  const s = await agent.newSession(os.tmpdir());
  if (fastModel) {
    const cur = s.configOptions?.find((o) => o.category === 'model')?.currentValue;
    if (cur !== fastModel) await agent.setConfigOption(s.sessionId, 'model', fastModel);
  }
  const t = Date.now();
  await agent.prompt(s.sessionId, [{ type: 'text', text: prompt }]);
  const out = text.get(s.sessionId) ?? '';
  await agent.closeSession(s.sessionId);
  F.deleteBuilderSession(F.defaultConfigDir(), s.sessionId);
  return { out, ms: Date.now() - t };
}

try {
  const t0 = Date.now();
  await agent.initialize();
  console.log(`utility agent ready in ${((Date.now() - t0) / 1000).toFixed(1)}s (model: ${fastModel ?? 'default'})`);

  console.log('Tab completion round-trip');
  const prefix = 'def add(a, b):\n    return ';
  const suffix = '\n\nprint(add(1, 2))\n';
  const c = await ask(buildCompletionPrompt({ rel: 'x.py', lang: 'python', prefix, suffix }));
  const cleaned = cleanCompletion(c.out, prefix, suffix);
  console.log(`    raw=${JSON.stringify(c.out.slice(0, 80))} -> ${JSON.stringify(cleaned)} (${c.ms} ms)`);
  check(/a\s*\+\s*b/.test(cleaned), 'completion is `a + b`');
  check(!/```/.test(cleaned) && !/puppy|woof|🐶/i.test(c.out), 'no fences / persona chatter (utility system prompt active)');

  console.log('Inline edit round-trip');
  const e = await ask(
    buildInlinePrompt({ rel: 'x.py', lang: 'python', instruction: 'rename parameter b to y', before: '', selected: 'def add(a, b):\n    return a + b', after: '' }),
  );
  const code = extractCode(e.out);
  console.log(`    ${JSON.stringify(code)} (${e.ms} ms)`);
  check(/def add\(a, y\):/.test(code) && /a \+ y/.test(code), 'inline edit renamed the parameter');
} catch (e) {
  console.log('  ✖ error', e.stack ?? e);
  failed++;
} finally {
  agent.dispose();
}
process.exit(failed ? 1 : 0);
