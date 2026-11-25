// Session state, rate limiting, daily budget, cache and the single-flight queue.
// Everything that must survive a restart (budget, captcha history, pause) is persisted.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export class BridgeError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

const RETRYABLE = new Set(['upstream_timeout', 'upstream_error', 'upstream_busy', 'rate_limited', 'busy']);
export const isRetryable = (code) => RETRYABLE.has(code);

const today = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export class State {
  constructor(config) {
    this.config = config;
    this.file = join(config.dataDir, 'state.json');
    mkdirSync(config.dataDir, { recursive: true });
    this.persisted = this.#load();
    this.session = { state: this.persisted.blockedBy || 'unknown', since: Date.now(), detail: null };
    this.lastCallAt = 0;
    this.lastSuccessAt = this.persisted.lastSuccessAt || null;
    this.cache = new Map();
    this.inflight = new Map();
    this.chain = Promise.resolve();
    this.queued = 0;
  }

  #load() {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  #save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.persisted, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  #rollDay() {
    const d = today(this.config.timezone);
    if (this.persisted.day !== d) {
      this.persisted.day = d;
      this.persisted.calls = 0;
      this.persisted.captchas = 0;
      this.#save();
    }
  }

  budget() {
    this.#rollDay();
    const used = this.persisted.calls || 0;
    return { day: this.persisted.day, used, limit: this.config.dailyCalls, remaining: Math.max(0, this.config.dailyCalls - used) };
  }

  // Throws if no Taobao call may be made right now.
  assertCanCall(calls = 1) {
    this.#rollDay();
    if (this.persisted.paused) throw new BridgeError('paused', 'The bridge is paused by its owner. Run `taobao resume`.', { action: 'Ask the user; do not retry.' });
    if (this.persisted.blockedBy === 'captcha_required') throw captchaError(this.config);
    if (this.persisted.blockedBy === 'login_required') throw loginError();
    const now = Date.now();
    if (this.persisted.cooldownUntil && now < this.persisted.cooldownUntil) {
      const retryAfterSec = Math.ceil((this.persisted.cooldownUntil - now) / 1000);
      throw new BridgeError('rate_limited', 'Cooling down after a verification challenge.', { retryAfterSec });
    }
    const b = this.budget();
    if (b.remaining < calls) {
      throw new BridgeError('rate_limited', `Daily budget of ${b.limit} Taobao calls used up.`, { retryAfterSec: secondsToMidnight(this.config.timezone) });
    }
  }

  // Waits for the polite gap between Taobao calls, then counts the call.
  async takeCall() {
    this.assertCanCall();
    const slow = this.persisted.slowUntil && Date.now() < this.persisted.slowUntil ? 2 : 1;
    const { minGapMs, maxGapMs } = this.config;
    const gap = (minGapMs + Math.random() * (maxGapMs - minGapMs)) * slow;
    const wait = this.lastCallAt + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();
    this.persisted.calls = (this.persisted.calls || 0) + 1;
    this.#save();
  }

  markOk() {
    this.session = { state: 'ok', since: this.session.state === 'ok' ? this.session.since : Date.now(), detail: null };
    this.lastSuccessAt = Date.now();
    this.persisted.lastSuccessAt = this.lastSuccessAt;
    this.#save();
  }

  markBlocked(kind, detail) {
    this.session = { state: kind, since: Date.now(), detail: detail || null };
    this.persisted.blockedBy = kind;
    if (kind === 'captcha_required') {
      this.#rollDay();
      this.persisted.captchas = (this.persisted.captchas || 0) + 1;
      this.persisted.lastCaptchaAt = Date.now();
    }
    this.#save();
  }

  markSession(kind, detail) {
    // Observed state without blocking (e.g. a cheap cookie check).
    this.session = { state: kind, since: this.session.state === kind ? this.session.since : Date.now(), detail: detail || null };
  }

  // Human says the challenge/login is solved. After a captcha: half pace for 24h;
  // a second captcha the same day requires force (and a cooldown is applied).
  resume({ force = false } = {}) {
    this.#rollDay();
    const wasCaptcha = this.persisted.blockedBy === 'captcha_required';
    if (wasCaptcha && (this.persisted.captchas || 0) >= this.config.maxCaptchasPerDay && !force) {
      throw new BridgeError('needs_force', `There were ${this.persisted.captchas} verification challenges today. Resume with --force only if you accept the risk.`);
    }
    this.persisted.paused = false;
    this.persisted.blockedBy = null;
    if (wasCaptcha) {
      this.persisted.slowUntil = Date.now() + 24 * 3600e3;
      if ((this.persisted.captchas || 0) >= this.config.maxCaptchasPerDay) this.persisted.cooldownUntil = Date.now() + this.config.cooldownMs;
    }
    this.session = { state: 'unknown', since: Date.now(), detail: 'resumed' };
    this.#save();
  }

  pause() {
    this.persisted.paused = true;
    this.#save();
  }

  // Cache + coalescing of identical in-flight requests.
  async cached(key, fn) {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.config.cacheMs) return { value: hit.value, cached: true, fetchedAt: hit.at };
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = this.exclusive(fn)
      .then((value) => {
        const at = Date.now();
        this.cache.set(key, { at, value });
        return { value, cached: false, fetchedAt: at };
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  // Runs fn with concurrency 1; rejects if the queue is too long to wait for.
  exclusive(fn) {
    if (this.queued >= this.config.maxQueue) {
      return Promise.reject(new BridgeError('busy', 'Too many searches queued; try again shortly.', { retryAfterSec: 30 }));
    }
    this.queued++;
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {}).finally(() => { this.queued--; });
    return run;
  }

  status() {
    return {
      session: this.session.state,
      sessionSince: new Date(this.session.since).toISOString(),
      detail: this.session.detail,
      paused: !!this.persisted.paused,
      lastSuccessAt: this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
      captchasToday: this.budget().day === this.persisted.day ? this.persisted.captchas || 0 : 0,
      slowModeUntil: this.persisted.slowUntil && this.persisted.slowUntil > Date.now() ? new Date(this.persisted.slowUntil).toISOString() : null,
      cooldownUntil: this.persisted.cooldownUntil && this.persisted.cooldownUntil > Date.now() ? new Date(this.persisted.cooldownUntil).toISOString() : null,
      budget: this.budget(),
      queue: this.queued,
    };
  }
}

export function captchaError(config) {
  return new BridgeError('captcha_required', 'Taobao is asking for a slider verification.', {
    action: `Send the user this link to solve it from a device on Tailscale: ${config.webViewUrl || 'the bridge web view'} (drag the slider slowly; if it shows an error, click 请点我重试 and try again). Then run \`taobao resume\`.`,
  });
}

export function loginError() {
  return new BridgeError('login_required', 'The Taobao session has expired.', {
    action: 'Run `taobao login`, send the user the QR image it prints, wait for `taobao login --wait`.',
  });
}

function secondsToMidnight(tz) {
  const now = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }).formatToParts(now).map((p) => [p.type, p.value]));
  return 86400 - (Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second));
}
