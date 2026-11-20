import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JsonRpcPeer, extractJsonLine } = require('../dist/lib/rpc.js');
const { AcpAgent } = require('../dist/lib/agent.js');
const { parseEnvOutput } = require('../dist/lib/shellEnv.js');

test('extractJsonLine strips OSC/CSI noise glued in front of JSON', () => {
  const osc = '\u001b]11;#1a1b26\u0007\u001b]10;#c0caf5\u0007';
  assert.equal(extractJsonLine(osc + '{"a":1}'), '{"a":1}');
  assert.equal(extractJsonLine('\u001b[32m{"a":2}\u001b[0m'), '{"a":2}');
  assert.equal(extractJsonLine(osc), undefined);
  assert.equal(extractJsonLine('hello world'), undefined);
});

test('request/response correlation and error mapping', async () => {
  const sent = [];
  const peer = new JsonRpcPeer((l) => sent.push(JSON.parse(l)));
  const p1 = peer.request('a', { x: 1 });
  const p2 = peer.request('b');
  peer.feed(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -1, message: 'boom' } }) + '\n');
  peer.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }) + '\n');
  assert.deepEqual(await p1, { ok: true });
  await assert.rejects(p2, /boom/);
  assert.equal(sent[0].method, 'a');
});

test('chunked stdout and noise lines are tolerated', async () => {
  const logs = [];
  const peer = new JsonRpcPeer(() => {}, (l) => logs.push(l));
  const notes = [];
  peer.onNotification((m, p) => notes.push([m, p]));
  const line = '\u001b]4;1;#f7768e\u0007' + JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { n: 1 } });
  peer.feed(line.slice(0, 20));
  peer.feed(line.slice(20) + '\nthis is not json\n');
  assert.equal(notes.length, 1);
  assert.ok(logs.some((l) => l.includes('this is not json')));
});

test('agent->client requests are answered; unknown methods error', async () => {
  const out = [];
  const peer = new JsonRpcPeer((l) => out.push(JSON.parse(l)));
  new AcpAgent(peer, {
    onUpdate() {},
    requestPermission: async () => ({ outcome: 'selected', optionId: 'allow_once' }),
    readTextFile: async () => ({ content: 'hello' }),
  });
  peer.feed(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: { sessionId: 's', toolCall: { toolCallId: 't' }, options: [] } }) + '\n');
  peer.feed(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'fs/read_text_file', params: { sessionId: 's', path: '/x' } }) + '\n');
  peer.feed(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'fs/write_text_file', params: {} }) + '\n');
  await new Promise((r) => setTimeout(r, 20));
  const byId = Object.fromEntries(out.map((m) => [m.id, m]));
  assert.deepEqual(byId[7].result, { outcome: { outcome: 'selected', optionId: 'allow_once' } });
  assert.deepEqual(byId[8].result, { content: 'hello' });
  assert.equal(byId[9].error.code, -32601); // no writeTextFile handler registered
});

test('close() rejects in-flight requests', async () => {
  const peer = new JsonRpcPeer(() => {});
  const p = peer.request('x');
  peer.close('gone');
  await assert.rejects(p, /gone/);
  await assert.rejects(peer.request('y'), /closed/);
});

test('parseEnvOutput ignores shell chatter before the marker', () => {
  const env = parseEnvOutput('welcome banner\nFOO=bar\n__BUILDER_ENV_START__\nPATH=/a:/b\nHOME=/h\nnot env line\n');
  assert.deepEqual(env, { PATH: '/a:/b', HOME: '/h' });
});
