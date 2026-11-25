// HTTP API of the Taobao bridge. Search-only surface: it never exposes the browser.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { State, BridgeError, isRetryable } from './state.mjs';
import { Taobao, SORTS } from './taobao.mjs';
import { normalizeSearch, PLATFORMS } from './normalize.mjs';

const env = process.env;
const config = {
  host: env.HOST || '0.0.0.0',
  port: Number(env.PORT || 8790),
  token: env.BRIDGE_TOKEN || '',
  cdpUrl: env.CDP_URL || 'http://127.0.0.1:9222',
  dataDir: env.DATA_DIR || './data',
  timezone: env.BUDGET_TZ || 'Asia/Shanghai',
  webViewUrl: env.WEB_VIEW_URL || '',
  dailyCalls: Number(env.DAILY_CALLS || 60),
  minGapMs: Number(env.MIN_GAP_MS || 6000),
  maxGapMs: Number(env.MAX_GAP_MS || 12000),
  cacheMs: Number(env.CACHE_MS || 45 * 60e3),
  cooldownMs: Number(env.COOLDOWN_MS || 45 * 60e3),
  maxCaptchasPerDay: Number(env.MAX_CAPTCHAS_PER_DAY || 2),
  maxQueue: Number(env.MAX_QUEUE || 3),
  maxPages: Number(env.MAX_PAGES || 2),
  maxLimit: Number(env.MAX_LIMIT || 20),
  navTimeoutMs: Number(env.NAV_TIMEOUT_MS || 25000),
  apiTimeoutMs: Number(env.API_TIMEOUT_MS || 12000),
};

if (config.token.length < 24) {
  console.error('BRIDGE_TOKEN must be set (at least 24 characters).');
  process.exit(1);
}

const log = (msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
const state = new State(config);
const taobao = new Taobao(config, state, log);

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(json);
}

function ok(res, data, meta = {}) {
  send(res, 200, { ok: true, data, meta: { ...meta, remainingToday: state.budget().remaining } });
}

const STATUS_BY_CODE = { unauthorized: 401, invalid_args: 400, not_found: 404, paused: 423, needs_force: 409, rate_limited: 429, busy: 429 };

function fail(res, err) {
  const code = err.code || 'internal_error';
  const status = STATUS_BY_CODE[code] || (code === 'internal_error' ? 500 : 503);
  if (code === 'internal_error' || !err.code) log('internal_error', { error: String(err.stack || err) });
  send(res, status, {
    ok: false,
    error: {
      code,
      message: err.code ? err.message : 'Unexpected bridge error.',
      retryable: isRetryable(code),
      retryAfterSec: err.retryAfterSec ?? null,
      action: err.action ?? null,
    },
    meta: { remainingToday: state.budget().remaining },
  });
}

function authorized(req) {
  const header = req.headers.authorization || '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(config.token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function intParam(sp, name, def, min, max) {
  const raw = sp.get(name);
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new BridgeError('invalid_args', `${name} must be an integer between ${min} and ${max}.`);
  return n;
}

function priceParam(sp, name) {
  const raw = sp.get(name);
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new BridgeError('invalid_args', `${name} must be a positive number.`);
  return n;
}

async function handleSearch(sp) {
  const q = (sp.get('q') || '').trim();
  if (!q || q.length > 100) throw new BridgeError('invalid_args', 'q is required (max 100 characters).');
  const sort = sp.get('sort') || 'relevance';
  if (!(sort in SORTS)) throw new BridgeError('invalid_args', `sort must be one of: ${Object.keys(SORTS).join(', ')}.`);
  const page = intParam(sp, 'page', 1, 1, config.maxPages);
  const limit = intParam(sp, 'limit', 8, 1, config.maxLimit);
  const minPrice = priceParam(sp, 'min_price');
  const maxPrice = priceParam(sp, 'max_price');
  const includeAds = sp.get('include_ads') === 'true';
  const platform = sp.get('tmall_only') === 'true' ? 'tmall' : (sp.get('platform') || 'mixed');
  if (!PLATFORMS.includes(platform)) throw new BridgeError('invalid_args', `platform must be one of: ${PLATFORMS.join(', ')}.`);

  const key = JSON.stringify({ q, sort, page, minPrice, maxPrice });
  const started = Date.now();
  const { value: raw, cached, fetchedAt } = await state.cached(key, () => taobao.search({ q, sort, page, minPrice, maxPrice }));
  const result = normalizeSearch(raw, { includeAds, limit, platform });
  log('search', { sort, page, cached, ms: Date.now() - started, returned: result.returnedCount });
  return {
    data: {
      query: q,
      searchUrl: `https://s.taobao.com/search?q=${encodeURIComponent(q)}`,
      sort,
      page: result.page,
      items: result.items,
      returnedCount: result.returnedCount,
      platform,
      matchedOnPage: result.matchedOnPage,
      platformCountsOnPage: result.platformCounts,
      hasMore: result.hasMore && page < config.maxPages,
      nextPage: result.hasMore && page < config.maxPages ? page + 1 : null,
      totalResultsApprox: result.totalResultsApprox,
    },
    meta: { cached, fetchedAt: new Date(fetchedAt).toISOString() },
  };
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) throw new BridgeError('invalid_args', 'Body too large.');
  }
  if (!body) return {};
  try { return JSON.parse(body); } catch { throw new BridgeError('invalid_args', 'Body must be JSON.'); }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://bridge');
  try {
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
    if (!authorized(req)) throw new BridgeError('unauthorized', 'Missing or wrong bridge token.');

    if (req.method === 'GET' && url.pathname === '/v1/search') {
      const { data, meta } = await handleSearch(url.searchParams);
      return ok(res, data, meta);
    }
    if (req.method === 'GET' && url.pathname === '/v1/status') {
      // While a captcha is pending we stay detached from Chromium so the owner can solve it.
      if (state.persisted.blockedBy === 'captcha_required') {
        return ok(res, { ...state.status(), browser: 'detached_for_captcha', sessionCookies: null });
      }
      let cookies = null;
      try { cookies = await taobao.hasSessionCookies(); } catch (e) { cookies = null; }
      if (cookies === false && state.session.state !== 'login_required') state.markSession('login_required', 'session cookies missing');
      return ok(res, { ...state.status(), browser: cookies === null ? 'unreachable' : 'ok', sessionCookies: cookies });
    }
    if (req.method === 'POST' && url.pathname === '/v1/login') {
      const body = await readJson(req);
      const r = await state.exclusive(() => taobao.startLogin({ force: !!body.force }));
      if (r.alreadyLoggedIn) return ok(res, { alreadyLoggedIn: true });
      log('login_qr_issued');
      return ok(res, { alreadyLoggedIn: false, qrPngBase64: r.png.toString('base64'), issuedAt: new Date(r.startedAt).toISOString() });
    }
    if (req.method === 'GET' && url.pathname === '/v1/login') {
      return ok(res, await taobao.loginStatus());
    }
    if (req.method === 'POST' && url.pathname === '/v1/resume') {
      const body = await readJson(req);
      state.resume({ force: !!body.force });
      log('resume', { force: !!body.force });
      return ok(res, state.status());
    }
    if (req.method === 'POST' && url.pathname === '/v1/pause') {
      state.pause();
      log('pause');
      return ok(res, state.status());
    }
    throw new BridgeError('not_found', `No route ${req.method} ${url.pathname}.`);
  } catch (err) {
    if (err.code && err.code !== 'unauthorized' && err.code !== 'not_found') log('error', { code: err.code, message: err.message });
    fail(res, err);
  }
});

server.listen(config.port, config.host, () => log('listening', { host: config.host, port: config.port, dailyCalls: config.dailyCalls }));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
