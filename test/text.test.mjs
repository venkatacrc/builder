import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractCode, cleanCompletion, trimCommon, buildInlinePrompt } = require('../dist/lib/text.js');

test('extractCode: fenced, unterminated, and bare answers', () => {
  assert.equal(extractCode('Sure!\n```ts\nconst a = 1;\n```\nDone'), 'const a = 1;');
  assert.equal(extractCode('```python\nprint(1)\nprint(2)'), 'print(1)\nprint(2)');
  assert.equal(extractCode('\nx = 1\n'), 'x = 1');
});

test('cleanCompletion removes fences, echoed prefix and echoed suffix', () => {
  assert.equal(cleanCompletion('```js\nfoo(1, 2)\n```', 'const x = ', ''), 'foo(1, 2)');
  // model repeats what is already typed on the line
  assert.equal(cleanCompletion('const x = compute()', 'const x = ', ''), 'compute()');
  // model repeats the closing line that already follows the cursor
  assert.equal(cleanCompletion('  return 1;\n}', 'function f() {\n', '}'), '  return 1;\n');
  assert.equal(cleanCompletion('   ', 'a', 'b'), '');
  assert.equal(cleanCompletion('a<CURSOR>b', '', ''), 'ab');
});

test('trimCommon finds the minimal replacement window', () => {
  const r = trimCommon('hello brave world', 'hello cruel world');
  assert.deepEqual(r, { start: 6, endOld: 11, endNew: 11 });
  assert.deepEqual(trimCommon('same', 'same'), { start: 4, endOld: 4, endNew: 4 });
  const ins = trimCommon('ab', 'aXb');
  assert.equal('ab'.slice(0, ins.start) + 'aXb'.slice(ins.start, ins.endNew) + 'ab'.slice(ins.endOld), 'aXb');
});

test('buildInlinePrompt carries the instruction and all three regions', () => {
  const p = buildInlinePrompt({ rel: 'a.ts', lang: 'typescript', instruction: 'rename x', before: 'B', selected: 'S', after: 'A' });
  for (const needle of ['rename x', '<before>\nB\n</before>', '<selection>\nS\n</selection>', '<after>\nA\n</after>', 'a.ts']) {
    assert.ok(p.includes(needle), needle);
  }
});
