import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../src/state.mjs';

const make = (over = {}) => new State({
  dataDir: mkdtempSync(join(tmpdir(), 'tb-state-')), timezone: 'Asia/Shanghai', webViewUrl: 'https://x/',
  dailyCalls: 2, minGapMs: 0, maxGapMs: 1, cacheMs: 60_000, cooldownMs: 60_000, maxCaptchasPerDay: 2, maxQueue: 2, ...over,
});

test('daily budget is enforced and persisted', async () => {
  const s = make();
  await s.takeCall();
  await s.takeCall();
  assert.throws(() => s.assertCanCall(), { code: 'rate_limited' });
  const again = new State(s.config);
  assert.equal(again.budget().used, 2);
});

test('captcha blocks until resume; second captcha needs force and cools down', () => {
  const s = make({ dailyCalls: 50 });
  s.markBlocked('captcha_required');
  assert.throws(() => s.assertCanCall(), { code: 'captcha_required' });
  s.resume();
  assert.doesNotThrow(() => s.assertCanCall());
  assert.ok(s.status().slowModeUntil);
  s.markBlocked('captcha_required');
  assert.throws(() => s.resume(), { code: 'needs_force' });
  s.resume({ force: true });
  assert.throws(() => s.assertCanCall(), { code: 'rate_limited' });
});

test('pause and login block calls', () => {
  const s = make({ dailyCalls: 50 });
  s.pause();
  assert.throws(() => s.assertCanCall(), { code: 'paused' });
  s.resume();
  s.markBlocked('login_required');
  assert.throws(() => s.assertCanCall(), { code: 'login_required' });
});

test('cache serves repeats and coalesces in-flight requests', async () => {
  const s = make();
  let calls = 0;
  const fn = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { n: calls }; };
  const [a, b] = await Promise.all([s.cached('k', fn), s.cached('k', fn)]);
  const c = await s.cached('k', fn);
  assert.equal(calls, 1);
  assert.equal(a.value.n, 1);
  assert.equal(b.value.n, 1);
  assert.equal(c.cached, true);
});
