import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const F = require('../dist/lib/puppyFiles.js');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-test-'));
  fs.writeFileSync(path.join(dir, 'puppy.cfg'), '[puppy]\nmodel = gpt-5.5\ndefault_agent = code-puppy\npuppy_token = SECRET\n');
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ 'm-a': { type: 'codex', name: 'a' }, 'm-b': { type: 'custom_anthropic', name: 'b' } }));
  fs.mkdirSync(path.join(dir, 'autosaves'), { recursive: true });
  const env = {
    format: 2,
    messages: [
      { kind: 'request', parts: [{ part_kind: 'system-prompt', content: 'sys' }] },
      {
        kind: 'request',
        parts: [{ content: '[Editor context] Active file: a.ts (typescript)\nCursor: line 1, column 1\n\n<context uri=\'file:///a.ts\'>\nxx\n</context>\n\nexplain this', timestamp: 't', part_kind: 'user-prompt' }],
      },
      { kind: 'response', parts: [{ tool_name: 'read_file', args: '{}', part_kind: 'tool-call' }] },
      { kind: 'response', parts: [{ content: 'It does X.', part_kind: 'text' }] },
    ],
  };
  fs.writeFileSync(path.join(dir, 'autosaves', 'auto_session_1.json'), JSON.stringify(env));
  fs.writeFileSync(
    path.join(dir, 'autosaves', 'auto_session_1_meta.json'),
    JSON.stringify({ session_name: 'auto_session_1', timestamp: '2026-11-13T15:49:41', message_count: 4, scope_key: '/tmp', title: 'Explain this' }),
  );
  return dir;
}

test('readPuppyCfg only returns requested keys (never the token)', () => {
  const dir = fixture();
  const cfg = F.readPuppyCfg(dir, ['model', 'default_agent']);
  assert.deepEqual(cfg, { model: 'gpt-5.5', default_agent: 'code-puppy' });
  assert.equal(JSON.stringify(cfg).includes('SECRET'), false);
});

test('readUserModels', () => {
  const dir = fixture();
  assert.deepEqual(F.readUserModels(dir).map((m) => m.id), ['m-a', 'm-b']);
});

test('CLI session -> import -> builder session listing -> transcript', () => {
  const dir = fixture();
  const cli = F.listCliSessions(dir);
  assert.equal(cli.length, 1);
  assert.equal(cli[0].title, 'Explain this');

  const id = F.importCliSession(dir, cli[0], '/tmp');
  assert.match(id, /^sess_imp_/);
  const builder = F.listBuilderSessions(dir);
  assert.equal(builder.length, 1);
  assert.equal(builder[0].id, id);
  assert.equal(builder[0].cwd, '/tmp');
  assert.equal(builder[0].title, 'explain this'); // derived from the first user prompt, context stripped

  const t = F.readTranscript(builder[0].file);
  assert.deepEqual(t.map((e) => e.kind), ['user', 'tool', 'assistant']);
  assert.equal(t[0].text, 'explain this');

  F.deleteBuilderSession(dir, id);
  assert.equal(F.listBuilderSessions(dir).length, 0);
  // the CLI original is untouched
  assert.equal(F.listCliSessions(dir).length, 1);
});

test('MCP: list / toggle / add / remove round-trip with backup', () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'mcp_servers.json'), JSON.stringify({ mcp_servers: { one: { name: 'one', type: 'http', url: 'https://x/mcp' } } }));
  fs.writeFileSync(path.join(dir, 'mcp_registry.json'), JSON.stringify({ reg: { id: 'reg', name: 'reg', type: 'http', enabled: true, config: { url: 'https://y/mcp' } } }));
  let list = F.listMcpServers(dir);
  assert.deepEqual(list.map((s) => s.name), ['one', 'reg']);

  F.setMcpEnabled(dir, 'reg', false);
  assert.equal(F.listMcpServers(dir).find((s) => s.name === 'reg').enabled, false);
  F.setMcpEnabled(dir, 'one', false);
  assert.equal(F.listMcpServers(dir).find((s) => s.name === 'one').enabled, false);

  F.addMcpServer(dir, 'two', { type: 'stdio', command: 'npx', args: ['-y', 'x'] });
  assert.equal(F.listMcpServers(dir).length, 3);
  assert.throws(() => F.addMcpServer(dir, 'two', { type: 'http', url: 'u' }), /already exists/);

  F.removeMcpServer(dir, 'two');
  F.removeMcpServer(dir, 'reg');
  list = F.listMcpServers(dir);
  assert.deepEqual(list.map((s) => s.name), ['one']);
  assert.ok(fs.existsSync(path.join(dir, 'mcp_servers.json.builder-bak')), 'first write keeps a backup');
});
