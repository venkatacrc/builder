// Verifies the agent-dropdown mechanism: `/agent <name>` over ACP, then session/load to rebuild the session.
//   node test/integration/agent-switch.mjs [agent-name]   (default: code-reviewer)
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { AcpAgent } = require(path.join(root, 'dist/lib/agent.js'));
const { getShellEnv } = require(path.join(root, 'dist/lib/shellEnv.js'));
const F = require(path.join(root, 'dist/lib/puppyFiles.js'));

const target = process.argv[2] ?? 'code-reviewer';
const env = { ...(await getShellEnv()), PYTHONUNBUFFERED: '1', BUILDER_PERSIST_MODEL: '0' };
const install = F.locateCodePuppy(undefined, env);
const text = new Map();
const { agent } = AcpAgent.spawn(
  { command: install.python, args: [path.join(root, 'dist/python/builder_launcher.py'), '--acp'], cwd: os.tmpdir(), env },
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
const say = async (sid, t) => {
  text.set(sid, '');
  await agent.prompt(sid, [{ type: 'text', text: t }]);
  return text.get(sid) ?? '';
};

try {
  await agent.initialize();
  const s = await agent.newSession(os.tmpdir());
  const sid = s.sessionId;
  const before = await say(sid, 'In ten words or fewer: who are you and what is your name?');
  console.log('  before:', JSON.stringify(before.slice(0, 120)));

  const switchOut = await say(sid, `/agent ${target}`);
  console.log('  /agent output:', JSON.stringify(switchOut.replace(/\s+/g, ' ').slice(0, 160)));
  check(new RegExp(target, 'i').test(switchOut) || /switch|active|now/i.test(switchOut), '/agent acknowledged over ACP');

  await agent.loadSession(sid, os.tmpdir());
  const after = await say(sid, 'In ten words or fewer: who are you and what is your role?');
  console.log('  after: ', JSON.stringify(after.slice(0, 160)));
  check(after.length > 0 && after !== before, 'session answers after rebuild on the new agent');
  check(/review|bug|vulnerab|quality/i.test(after) || target !== 'code-reviewer', `persona reflects "${target}"`);
  await agent.closeSession(sid);
} catch (e) {
  console.log('  ✖ error', e.stack ?? e);
  failed++;
} finally {
  agent.dispose();
}
process.exit(failed ? 1 : 0);
