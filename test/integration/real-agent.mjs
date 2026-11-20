// End-to-end check against the REAL code-puppy install (uses your configured model; costs a few tokens).
//
//   node test/integration/real-agent.mjs            # all steps
//   node test/integration/real-agent.mjs --quick    # handshake + models + cfg safety only (no model call)
//
// It uses the same launcher + ACP client the extension uses, in a throw-away temp workspace.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { AcpAgent } = require(path.join(root, 'dist/lib/agent.js'));
const { getShellEnv } = require(path.join(root, 'dist/lib/shellEnv.js'));
const F = require(path.join(root, 'dist/lib/puppyFiles.js'));

const quick = process.argv.includes('--quick');
const configDir = F.defaultConfigDir();
const results = [];
const ok = (name, detail = '') => {
  results.push([true, name, detail]);
  console.log(`  ✔ ${name} ${detail}`);
};
const bad = (name, detail = '') => {
  results.push([false, name, detail]);
  console.log(`  ✖ ${name} ${detail}`);
};
const check = (cond, name, detail) => (cond ? ok(name, detail) : bad(name, detail));
const t0 = Date.now();
const since = () => `(${((Date.now() - t0) / 1000).toFixed(1)}s)`;

const env = { ...(await getShellEnv()), PYTHONUNBUFFERED: '1', BUILDER_PERSIST_MODEL: '0' };
const install = F.locateCodePuppy(undefined, env);
if (!install?.python) {
  console.error('code-puppy (with venv python) not found');
  process.exit(2);
}
console.log(`code-puppy: ${install.executable}\npython:     ${install.python}\n`);

const cfgBefore = fs.readFileSync(path.join(configDir, 'puppy.cfg'), 'utf8');
const modelLine = (t) => /^model\s*=.*$/m.exec(t)?.[0];

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-it-'));
const updates = [];
const writes = [];
const perms = [];

function start() {
  const handlers = {
    onUpdate: (sid, u) => updates.push({ sid, u }),
    requestPermission: async (req) => {
      perms.push(req.toolCall?.title);
      const allow = req.options.find((o) => o.kind === 'allow_once') ?? req.options[0];
      return { outcome: 'selected', optionId: allow.optionId };
    },
    readTextFile: async (p) => ({ content: fs.readFileSync(p.path, 'utf8') }),
    writeTextFile: async (p) => {
      writes.push(p.path);
      fs.mkdirSync(path.dirname(p.path), { recursive: true });
      fs.writeFileSync(p.path, p.content);
    },
  };
  const { agent, proc } = AcpAgent.spawn(
    { command: install.python, args: [path.join(root, 'dist/python/builder_launcher.py'), '--acp'], cwd: workspace, env, log: (l) => process.env.VERBOSE && console.log('    ', l.slice(0, 200)) },
    handlers,
  );
  return { agent, proc };
}

const text = (sid) => updates.filter((x) => x.sid === sid && x.u.sessionUpdate === 'agent_message_chunk').map((x) => x.u.content?.text ?? '').join('');

let a, sid;
try {
  console.log('1. Handshake');
  ({ agent: a } = start());
  const info = await a.initialize();
  ok('initialize', `${info.agentInfo?.title} ${info.agentInfo?.version} ${since()}`);
  check(info.agentCapabilities?.loadSession === true, 'agent supports session/load');
  check(!!info.agentCapabilities?.sessionCapabilities?.close, 'agent supports session/close');

  console.log('2. Session + model catalog');
  const s = await a.newSession(workspace);
  sid = s.sessionId;
  ok('session/new', sid);
  const model = s.configOptions?.find((o) => o.category === 'model');
  check(!!model && model.options.length > 3, 'model dropdown source', `${model?.options.length} models, current=${model?.currentValue}`);
  const userModels = F.readUserModels(configDir).map((m) => m.id);
  const offered = new Set(model?.options.map((o) => o.value));
  const missing = userModels.filter((m) => !offered.has(m));
  check(missing.length === 0, 'every models.json entry is offered over ACP', missing.length ? `missing: ${missing.join(', ')}` : '');

  console.log('3. Launcher keeps puppy.cfg untouched when switching model');
  const other = model.options.find((o) => o.value !== model.currentValue)?.value;
  if (other) {
    await a.setConfigOption(sid, 'model', other);
    const cfgAfter = fs.readFileSync(path.join(configDir, 'puppy.cfg'), 'utf8');
    check(modelLine(cfgBefore) === modelLine(cfgAfter), 'puppy.cfg model line unchanged after switching to ' + other, `${modelLine(cfgAfter)}`);
    await a.setConfigOption(sid, 'model', model.currentValue); // restore in-process
  }

  if (!quick) {
    console.log('4. Streaming prompt');
    const n0 = updates.length;
    const res = await a.prompt(sid, [{ type: 'text', text: 'Reply with exactly the single word: pong' }]);
    check(res.stopReason === 'end_turn', 'stopReason end_turn', res.stopReason);
    const reply = text(sid);
    check(/pong/i.test(reply), 'streamed reply contains "pong"', JSON.stringify(reply.slice(0, 60)));
    check(updates.length - n0 >= 1, 'received session/update notifications', `${updates.length - n0} updates ${since()}`);

    console.log('5. Agent edits a file through fs/write_text_file (client-side write + approval)');
    updates.length = 0;
    const target = path.join(workspace, 'hello.txt');
    const res2 = await a.prompt(sid, [
      { type: 'text', text: `Create a file named hello.txt in the current working directory containing exactly: hi from builder. Use your file tools. Do not run shell commands.` },
    ]);
    check(res2.stopReason === 'end_turn', 'edit turn finished', res2.stopReason);
    check(writes.some((w) => w.endsWith('hello.txt')), 'write arrived via fs/write_text_file (client-controlled)', `writes=${writes.map((w) => path.basename(w))}, approvals=${JSON.stringify(perms)}`);
    check(fs.existsSync(target) && /hi from builder/.test(fs.readFileSync(target, 'utf8')), 'file exists with expected content');
    const tools = updates.filter((x) => x.u.sessionUpdate === 'tool_call').map((x) => x.u.title);
    check(tools.length > 0, 'tool_call updates streamed', JSON.stringify(tools.slice(0, 4)));

    console.log('6. Persisted session resumes in a NEW process (session/load + history replay)');
    a.dispose();
    await new Promise((r) => setTimeout(r, 1500));
    const sessions = F.listBuilderSessions(configDir);
    check(sessions.some((x) => x.id === sid), 'session persisted under autosaves/acp', sid);
    updates.length = 0;
    ({ agent: a } = start());
    await a.initialize();
    await a.loadSession(sid, workspace);
    const replayedUser = updates.filter((x) => x.u.sessionUpdate === 'user_message_chunk').map((x) => x.u.content?.text ?? '');
    check(replayedUser.some((t) => /pong/.test(t)), 'history replayed to the client', `${replayedUser.length} user msgs ${since()}`);
    const res3 = await a.prompt(sid, [{ type: 'text', text: 'What single word did I ask you to reply with in my first message? Answer with just that word.' }]);
    check(/pong/i.test(text(sid)), 'agent remembers the conversation after resume', JSON.stringify(text(sid).slice(-60)));
    void res3;
  }
} catch (e) {
  bad('unexpected error', e.stack ?? String(e));
} finally {
  try {
    if (a && sid) await a.closeSession(sid);
  } catch {}
  a?.dispose();
  fs.rmSync(workspace, { recursive: true, force: true });
  // clean up sessions this run created (Builder-owned dir only)
  try {
    if (sid) F.deleteBuilderSession(configDir, sid);
  } catch {}
}

const cfgEnd = fs.readFileSync(path.join(configDir, 'puppy.cfg'), 'utf8');
check(modelLine(cfgBefore) === modelLine(cfgEnd), 'puppy.cfg default model unchanged at end of run');

const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exit(failed.length ? 1 : 0);
