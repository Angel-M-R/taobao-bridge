// Talks to the logged-in Chromium over CDP (localhost only) and runs Taobao searches.
// Page 1 of a query is a real navigation whose own search request we intercept; other
// sorts/pages reuse the captured request template through Taobao's own signed client
// (window.lib.mtop.request), which is equivalent to clicking the sort tab.
import { chromium } from 'playwright-core';
import { BridgeError, captchaError, loginError } from './state.mjs';
import { classifyRet } from './normalize.mjs';

const SEARCH_API = 'mtop.relationrecommend.wirelessrecommend.recommend';
const SEARCH_APP_ID = '34385';
export const SORTS = { relevance: '_coefp', sales: '_sale', price_asc: '_bid' };

const CAPTCHA_SELECTOR = '#baxia-dialog-content, #nc_1_wrapper, iframe[src*="punish"], iframe[src*="_____tmd_____"]';
const LOGIN_URL = 'https://login.taobao.com/member/login.jhtml?redirectURL=' + encodeURIComponent('https://www.taobao.com/');

function parseJsonp(text) {
  const body = text.trim().replace(/^[\w$.]+\(/, '').replace(/\)\s*;?\s*$/, '');
  return JSON.parse(body);
}

function searchParamsOf(url) {
  try {
    const data = new URL(url).searchParams.get('data');
    if (!data) return null;
    const parsed = JSON.parse(data);
    if (parsed.appId !== SEARCH_APP_ID) return null;
    return JSON.parse(parsed.params);
  } catch {
    return null;
  }
}

export class Taobao {
  constructor(config, state, log) {
    this.config = config;
    this.state = state;
    this.log = log;
    this.browser = null;
    this.worker = null;
    this.workerQuery = null; // query the worker tab is currently showing
    this.template = null; // params template captured from the last real navigation
    this.loginPage = null;
    this.loginStartedAt = 0;
  }

  async connect() {
    if (this.browser?.isConnected()) return this.browser;
    try {
      this.browser = await chromium.connectOverCDP(this.config.cdpUrl, { timeout: 10000 });
    } catch (e) {
      throw new BridgeError('browser_unavailable', `Cannot reach Chromium over CDP: ${e.message}`);
    }
    this.browser.on('disconnected', () => {
      this.browser = null;
      this.worker = null;
      this.workerQuery = null;
    });
    return this.browser;
  }

  context() {
    return this.browser.contexts()[0];
  }

  async workerPage() {
    await this.connect();
    if (!this.worker || this.worker.isClosed()) {
      // Reuse a results tab left from an earlier connection (e.g. after a captcha) so tabs don't pile up.
      const pages = this.context().pages();
      const reuse = pages.filter((p) => p.url().startsWith('https://s.taobao.com/search'));
      for (const extra of reuse.slice(1)) await extra.close().catch(() => {});
      this.worker = reuse[0] || (await this.context().newPage());
      this.workerQuery = null;
    }
    return this.worker;
  }

  // Cheap, no Taobao request: are the session cookies present?
  async hasSessionCookies() {
    await this.connect();
    const cookies = await this.context().cookies('https://www.taobao.com');
    const names = new Set(cookies.map((c) => c.name));
    return names.has('unb') && names.has('cookie2');
  }

  async pageState(page) {
    const url = page.url();
    if (/login\.(taobao|tmall)\.com|passport\./.test(url)) return 'login_required';
    if (/_____tmd_____|punish/.test(url)) return 'captcha_required';
    const captcha = await page.locator(CAPTCHA_SELECTOR).first().isVisible().catch(() => false);
    return captcha ? 'captcha_required' : 'ok';
  }

  // Drop the CDP connection (Chromium and its tabs keep running). The slider fails
  // while an automation client is attached, so the owner solves it with us detached.
  async release() {
    const browser = this.browser;
    this.browser = null;
    this.worker = null;
    this.workerQuery = null;
    if (browser) await browser.close().catch(() => {});
  }

  async #fail(kind, detail) {
    if (kind === 'captcha_required') {
      this.state.markBlocked(kind, detail);
      await this.release();
      this.log('cdp_released', { reason: 'captcha' });
      throw captchaError(this.config);
    }
    if (kind === 'login_required') {
      this.state.markBlocked(kind, detail);
      throw loginError();
    }
    if (kind === 'upstream_busy') throw new BridgeError('upstream_busy', `Taobao is throttling: ${detail}`, { retryAfterSec: 120 });
    throw new BridgeError('upstream_error', `Taobao returned an error: ${detail}`, { retryAfterSec: 60 });
  }

  // Real navigation to the results page; returns the page's own search response.
  async #navigate(query) {
    const page = await this.workerPage();
    await this.state.takeCall();
    const captured = new Promise((resolve) => {
      const onResponse = async (res) => {
        if (!res.url().includes(SEARCH_API.split('.').slice(-2).join('.'))) return;
        const params = searchParamsOf(res.url());
        if (!params) return;
        const text = await res.text().catch(() => '');
        let json = null;
        try { json = parseJsonp(text); } catch { return; }
        page.off('response', onResponse);
        resolve({ params, json });
      };
      page.on('response', onResponse);
      setTimeout(() => { page.off('response', onResponse); resolve(null); }, this.config.navTimeoutMs);
    });
    try {
      await page.goto(`https://s.taobao.com/search?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: this.config.navTimeoutMs });
    } catch (e) {
      throw new BridgeError('upstream_timeout', `Loading the Taobao results page failed: ${e.message}`, { retryAfterSec: 60 });
    }
    const got = await captured;
    if (!got) {
      const st = await this.pageState(page);
      if (st !== 'ok') await this.#fail(st, 'detected on the results page');
      if (!(await this.hasSessionCookies())) await this.#fail('login_required', 'session cookies missing');
      throw new BridgeError('upstream_timeout', 'Taobao did not return search results in time.', { retryAfterSec: 60 });
    }
    const kind = classifyRet(got.json.ret);
    if (kind !== 'ok') await this.#fail(kind, String(got.json.ret));
    this.workerQuery = query;
    this.template = got.params;
    return got;
  }

  // Signed request through Taobao's own client, reusing the captured template.
  async #direct(overrides, retried = false) {
    const page = await this.workerPage();
    await this.state.takeCall();
    const params = { ...this.template, ...overrides };
    const res = await page.evaluate(async ({ api, appId, params, timeoutMs }) => {
      if (!window.lib?.mtop?.request) return { __error: 'no_mtop' };
      const call = window.lib.mtop.request({ api, v: '2.0', type: 'GET', dataType: 'jsonp', timeout: timeoutMs, data: { appId, params: JSON.stringify(params) } });
      const timer = new Promise((r) => setTimeout(() => r({ __error: 'timeout' }), timeoutMs + 2000));
      try {
        return await Promise.race([call, timer]);
      } catch (e) {
        return e && e.ret ? e : { __error: String(e && e.message ? e.message : e) };
      }
    }, { api: SEARCH_API, appId: SEARCH_APP_ID, params, timeoutMs: this.config.apiTimeoutMs });

    if (res.__error) {
      const st = await this.pageState(page);
      if (st !== 'ok') await this.#fail(st, `detected after ${res.__error}`);
      if (res.__error === 'no_mtop') {
        this.workerQuery = null;
        throw new BridgeError('upstream_error', 'Taobao search client not loaded in the worker tab.', { retryAfterSec: 30 });
      }
      throw new BridgeError('upstream_timeout', `Taobao search request failed: ${res.__error}`, { retryAfterSec: 60 });
    }
    const kind = classifyRet(res.ret);
    if (kind === 'token_expired' && !retried) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(3000);
      return this.#direct(overrides, true);
    }
    if (kind !== 'ok') await this.#fail(kind === 'token_expired' ? 'upstream_error' : kind, String(res.ret));
    return { params, json: res };
  }

  // Estimated Taobao calls for a request, used to check the budget up front.
  callsNeeded({ q, sort, page, minPrice, maxPrice }) {
    const needsNav = this.workerQuery !== q || !this.template || !this.worker || this.worker.isClosed();
    const plain = sort === 'relevance' && page === 1 && minPrice == null && maxPrice == null;
    return needsNav ? (plain ? 1 : 2) : 1;
  }

  async search({ q, sort = 'relevance', page = 1, minPrice = null, maxPrice = null }) {
    this.state.assertCanCall(this.callsNeeded({ q, sort, page, minPrice, maxPrice }));
    const plain = sort === 'relevance' && page === 1 && minPrice == null && maxPrice == null;
    let result;
    if (this.workerQuery !== q || !this.template || !this.worker || this.worker.isClosed()) {
      result = await this.#navigate(q);
      if (!plain) result = null;
    }
    if (!result) {
      const pageSize = Number(this.template.pageSize) || 48;
      result = await this.#direct({
        sort: SORTS[sort],
        page,
        sourceS: String((page - 1) * pageSize),
        startPrice: minPrice,
        endPrice: maxPrice,
        start_price: minPrice,
        end_price: maxPrice,
      });
    }
    this.state.markOk();
    return result.json;
  }

  // ---- Login by QR -------------------------------------------------------------

  async startLogin({ force = false } = {}) {
    await this.connect();
    if (!force && (await this.hasSessionCookies()) && this.state.session.state !== 'login_required') {
      return { alreadyLoggedIn: true };
    }
    if (this.loginPage && !this.loginPage.isClosed()) await this.loginPage.close().catch(() => {});
    const page = await this.context().newPage();
    this.loginPage = page;
    this.loginStartedAt = Date.now();
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: this.config.navTimeoutMs });
    if (!/login\./.test(page.url())) {
      await page.close().catch(() => {});
      this.loginPage = null;
      return { alreadyLoggedIn: true };
    }
    const box = page.locator('.qrcode-login').first();
    await box.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    const qr = page.locator('.qrcode-login img, .qrcode-login canvas').first();
    const target = (await qr.isVisible().catch(() => false)) ? qr : box;
    if (!(await target.isVisible().catch(() => false))) {
      throw new BridgeError('upstream_changed', 'Could not find the login QR on the Taobao login page.');
    }
    await page.waitForTimeout(1000);
    const png = await target.screenshot({ type: 'png' });
    return { alreadyLoggedIn: false, png, startedAt: this.loginStartedAt };
  }

  async loginStatus() {
    await this.connect();
    const page = this.loginPage;
    if (page && !page.isClosed() && /login\./.test(page.url())) {
      const text = await page.locator('.qrcode-login').first().innerText().catch(() => '');
      if (/失效|过期|刷新/.test(text)) return { state: 'expired' };
      if (/扫描成功|确认登录|请在手机/.test(text)) return { state: 'scanned' };
      return { state: 'waiting' };
    }
    if (await this.hasSessionCookies()) {
      if (page && !page.isClosed()) await page.close().catch(() => {});
      this.loginPage = null;
      if (this.state.persisted.blockedBy === 'login_required') this.state.resume();
      this.state.markSession('ok', 'cookies present after login');
      return { state: 'logged_in' };
    }
    return { state: page ? 'unknown' : 'not_started' };
  }
}
