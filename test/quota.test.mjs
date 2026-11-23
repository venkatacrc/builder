import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseQuotaError, formatCountdown } = require('../dist/lib/quota.js');

const NOW = 1_800_000_000_000;
const SAMPLE =
  "\u26a0\ufe0f The agent run failed: status_code: 402, model_name: claude-opus-5-5, body: {'error': {'message': \"Large-model token quota exceeded for job family 'DATA SCIENCE'. Used 25430611/25000000 large-model tokens this period. Try again in 178 minutes.\", 'type': 'rate_limit_error'}, 'type': 'error'}";

test('parseQuotaError reads the retry time, model and provider message', () => {
  const q = parseQuotaError(SAMPLE, NOW);
  assert.equal(q.until, NOW + 178 * 60_000);
  assert.equal(q.model, 'claude-opus-5-5');
  assert.match(q.message, /^Large-model token quota exceeded for job family 'DATA SCIENCE'.*Try again in 178 minutes\.$/);
});

test('parseQuotaError handles seconds and hours, and ignores unrelated text', () => {
  assert.equal(parseQuotaError('429 Too Many Requests. Try again in 30 seconds', NOW).until, NOW + 30_000);
  assert.equal(parseQuotaError('rate_limit_error: try again in 2 hours', NOW).until, NOW + 7_200_000);
  assert.equal(parseQuotaError('Try again in 5 minutes if the build is still running.', NOW), undefined);
  assert.equal(parseQuotaError('quota exceeded', NOW), undefined);
});

test('formatCountdown', () => {
  assert.equal(formatCountdown(178 * 60_000), '2:58:00');
  assert.equal(formatCountdown(61_500), '1:02');
  assert.equal(formatCountdown(-5), '0:00');
});
