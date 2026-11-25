#!/usr/bin/env node
// `taobao`: thin client for the Taobao bridge. JSON on stdout, diagnostics on stderr.
// Config: TAOBAO_BRIDGE_URL / TAOBAO_BRIDGE_TOKEN, or ~/.config/taobao/config.json
//   { "url": "http://100.x.y.z:8450", "hostHeader": "bridge-host.your-tailnet.ts.net:8450", "token": "...", "cnyToEur": 0.13 }
import { readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';

const VERSION = '0.1.0';
const EXIT = { ok: 0, usage: 64, invalid_args: 64, login_required: 2, captcha_required: 3, rate_limited: 4, bridge_unreachable: 5, paused: 6, unauthorized: 7, upstream_changed: 8 };
const CACHE_DIR = join(homedir(), '.cache', 'taobao');

const HELP = `taobao ${VERSION}: search Taobao through the home bridge

Usage:
  taobao search <query...> [--sort relevance|sales|price_asc] [--limit N] [--page 1|2]
                           [--min-price CNY] [--max-price CNY] [--platform mixed|all|tmall|taobao]
                           [--tmall] [--ads] [--images]
  --platform: mixed (default) keeps the ranking but reserves about half of the results for
  each kind of store; all = pure ranking (sales sort is mostly Tmall); tmall / taobao = only that.
  taobao status
  taobao login [--force]       Get a login QR (PNG path printed) to send to the user
  taobao login --wait          Wait up to 3 min until the QR is scanned
  taobao resume [--force]      After the user solved the slider in the web view
  taobao pause                 Stop all Taobao calls until resume
  taobao --version

Output is JSON: {"ok":true,"data":...,"meta":...} or {"ok":false,"error":{code,message,retryable,retryAfterSec,action}}.
Exit codes: 0 ok, 2 login_required, 3 captcha_required, 4 rate_limited, 5 bridge_unreachable,
6 paused, 7 unauthorized, 8 upstream_changed, 1 other errors, 64 usage.`;

function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(readFileSync(join(homedir(), '.config', 'taobao', 'config.json'), 'utf8'));
  } catch {}
  const url = process.env.TAOBAO_BRIDGE_URL || file.url;
  const token = process.env.TAOBAO_BRIDGE_TOKEN || file.token;
  const cnyToEur = Number(process.env.TAOBAO_CNY_TO_EUR || file.cnyToEur) || null;
  // Tailscale Serve routes by hostname; hosts without MagicDNS call the IP and send this Host.
  const hostHeader = process.env.TAOBAO_BRIDGE_HOST || file.hostHeader || null;
  return { url: url?.replace(/\/$/, ''), token, cnyToEur, hostHeader };
}

// node:http instead of fetch so we can set the Host header (fetch forbids it).
function httpRequest(cfg, method, path, body) {
  const target = new URL(cfg.url + path);
  const lib = target.protocol === 'https:' ? https : http;
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = lib.request(target, {
      method,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        ...(cfg.hostHeader ? { host: cfg.hostHeader } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 120_000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function out(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exit(code);
}

function errorOut(code, message, extra = {}) {
  out({ ok: false, error: { code, message, retryable: false, retryAfterSec: null, action: null, ...extra } }, EXIT[code] ?? 1);
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2);
      const boolFlags = ['tmall', 'ads', 'images', 'force', 'wait', 'version', 'help'];
      if (boolFlags.includes(k)) flags[k] = true;
      else {
        const v = inline ?? argv[++i];
        if (v == null) errorOut('invalid_args', `--${k} needs a value.`);
        flags[k] = v;
      }
    } else positional.push(a);
  }
  return { flags, positional };
}

async function call(cfg, method, path, body) {
  if (!cfg.url || !cfg.token) errorOut('not_configured', 'Missing bridge URL/token. Create ~/.config/taobao/config.json with {"url","token"}.');
  let res;
  try {
    res = await httpRequest(cfg, method, path, body);
  } catch (e) {
    errorOut('bridge_unreachable', `Cannot reach the Taobao bridge at ${cfg.url}: ${e.code || e.message}`, {
      retryable: true, retryAfterSec: 60, action: 'The bridge host or Tailscale may be down. Tell the user; do not loop.',
    });
  }
  let json;
  try {
    json = JSON.parse(res.text);
  } catch {
    errorOut('bridge_error', `Bridge answered HTTP ${res.status} without JSON.`);
  }
  if (!json.ok) out(json, EXIT[json.error?.code] ?? 1);
  return json;
}

// WebP -> JPEG with python3 + Pillow when available; otherwise keep the WebP.
function toJpeg(src) {
  const dst = src.replace(/\.webp$/, '.jpg');
  const r = spawnSync('python3', ['-I', '-c',
    'import sys,os\nfrom PIL import Image\nImage.open(sys.argv[1]).convert("RGB").save(sys.argv[2],"JPEG",quality=85)\nos.chmod(sys.argv[2],0o600)',
    src, dst], { timeout: 15_000, stdio: 'ignore' });
  if (r.status !== 0) return src;
  try { unlinkSync(src); } catch {}
  return dst;
}

async function downloadImages(items) {
  const dir = join(CACHE_DIR, 'images');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  await Promise.all(items.map(async (item) => {
    if (!item.image) return;
    try {
      const url = item.image.replace(/(\.(jpg|jpeg|png|webp))(_.*)?$/i, '$1') + '_400x400.jpg';
      let res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { referer: 'https://s.taobao.com/' } });
      if (!res.ok) res = await fetch(item.image, { signal: AbortSignal.timeout(20_000), headers: { referer: 'https://s.taobao.com/' } });
      if (!res.ok) return;
      const type = res.headers.get('content-type') || '';
      const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
      const path = join(dir, `${item.id}.${ext}`);
      writeFileSync(path, Buffer.from(await res.arrayBuffer()), { mode: 0o600 });
      // Alicdn always serves WebP; WhatsApp handles JPEG photos best.
      item.imagePath = ext === 'webp' ? toJpeg(path) : path;
    } catch {}
  }));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);
  if (!cmd || cmd === 'help' || cmd === '--help' || flags.help) {
    process.stdout.write(HELP + '\n');
    process.exit(cmd ? 0 : 64);
  }
  if (cmd === '--version') out({ ok: true, data: { version: VERSION } });
  const cfg = loadConfig();

  if (cmd === 'search') {
    const q = positional.join(' ').trim();
    if (!q) errorOut('invalid_args', 'Usage: taobao search <query...>');
    const sp = new URLSearchParams({ q });
    for (const [flag, param] of [['sort', 'sort'], ['limit', 'limit'], ['page', 'page'], ['min-price', 'min_price'], ['max-price', 'max_price']]) {
      if (flags[flag] != null) sp.set(param, flags[flag]);
    }
    if (flags.platform) sp.set('platform', flags.platform);
    if (flags.tmall) sp.set('platform', 'tmall');
    if (flags.ads) sp.set('include_ads', 'true');
    const json = await call(cfg, 'GET', `/v1/search?${sp}`);
    if (cfg.cnyToEur) {
      for (const it of json.data.items) {
        if (it.price?.current != null) it.price.approxEur = Math.round(it.price.current * cfg.cnyToEur * 100) / 100;
      }
      json.meta.cnyToEur = cfg.cnyToEur;
    }
    if (flags.images) await downloadImages(json.data.items);
    out(json);
  }

  if (cmd === 'status') out(await call(cfg, 'GET', '/v1/status'));

  if (cmd === 'login') {
    if (flags.wait) {
      const deadline = Date.now() + 180_000;
      let last;
      while (Date.now() < deadline) {
        last = await call(cfg, 'GET', '/v1/login');
        if (['logged_in', 'expired', 'not_started'].includes(last.data.state)) break;
        await new Promise((r) => setTimeout(r, 4000));
      }
      out(last, last?.data?.state === 'logged_in' ? 0 : EXIT.login_required);
    }
    const json = await call(cfg, 'POST', '/v1/login', { force: !!flags.force });
    if (json.data.alreadyLoggedIn) out(json);
    mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    const path = join(CACHE_DIR, `login-qr-${Date.now()}.png`);
    writeFileSync(path, Buffer.from(json.data.qrPngBase64, 'base64'), { mode: 0o600 });
    out({ ok: true, data: { alreadyLoggedIn: false, qrPath: path, issuedAt: json.data.issuedAt, next: 'Send the QR image to the user (to scan with the Taobao app), then run `taobao login --wait`. The QR expires in a few minutes.' }, meta: json.meta });
  }

  if (cmd === 'resume') out(await call(cfg, 'POST', '/v1/resume', { force: !!flags.force }));
  if (cmd === 'pause') out(await call(cfg, 'POST', '/v1/pause', {}));

  errorOut('invalid_args', `Unknown command "${cmd}". Run \`taobao help\`.`);
}

main().catch((e) => errorOut('cli_error', e.message));
