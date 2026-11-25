# taobao-bridge

Let an AI agent search **Taobao / Tmall** and get back, per product: title, price (with discount type), sales, shop, Tmall or Taobao, location, badges, image and link.

It drives a **real, logged-in Chromium on a machine with a residential IP** and calls Taobao's own search client from inside the page, so Taobao's JavaScript does the request signing. Nothing is reverse-engineered, and nothing parses the DOM. The agent never touches the browser: it gets a small, token-protected, search-only HTTP API and a CLI.

Built for a [Hermes Agent](https://github.com/NousResearch/hermes-agent) that talks to its owner over WhatsApp, but the CLI prints plain JSON and works with any agent.

```
WhatsApp ─ agent (VPS) ─ `taobao` CLI ──HTTP over Tailscale + bearer token──▶ taobao-bridge (home PC)
                                                                              ├─ chromium (logged-in profile, web view for login/slider)
                                                                              └─ bridge API (Node, playwright-core over CDP on localhost)
```

> **Disclaimer.** This automates searches on your own Taobao account at a human-like pace, for personal use. Taobao may challenge or restrict accounts that it considers automated. You use it at your own risk, and you are responsible for complying with Taobao's terms.

## What's in the repo

| Path | What |
|---|---|
| `compose.yaml` | `chromium` (linuxserver/chromium with a Selkies web view) + `bridge` (shares its network namespace, so CDP stays on localhost) |
| `bridge/` | Search-only HTTP API: budget, pacing, cache, captcha/login detection, QR login |
| `cli/taobao.mjs` | Dependency-free Node 22 CLI for the agent host |
| `skill/SKILL.md` | Hermes skill: how to search (in Chinese), present results and handle errors |
| `DESIGN.md` | Design notes, reviews and spike findings |

## Setup

### 1. Bridge (home PC with Docker and Tailscale)

```sh
cp .env.example .env && chmod 600 .env     # set BRIDGE_TOKEN (openssl rand -hex 24), WEB_VIEW_PASSWORD, WEB_VIEW_URL
docker compose up -d --build
# Publish to your tailnet only:
tailscale serve --bg --http=8450  http://127.0.0.1:8790            # search API (for the agent)
tailscale serve --bg --https=8451 https+insecure://127.0.0.1:3911  # web view (for you: login and slider)
```

Open the web view, log in to Taobao (QR with the Taobao app) and run one search by hand. If a slider appears, solve it there.

### 2. CLI (agent host)

```sh
install -m 755 cli/taobao.mjs ~/.local/bin/taobao
mkdir -p ~/.config/taobao && cat > ~/.config/taobao/config.json <<'EOF'
{ "url": "http://bridge-host.your-tailnet.ts.net:8450", "token": "<BRIDGE_TOKEN>" }
EOF
chmod 600 ~/.config/taobao/config.json
taobao status
```

If the agent host has no MagicDNS, use the Tailscale IP and send the hostname as `Host`, because Tailscale Serve routes by hostname: `{ "url": "http://100.x.y.z:8450", "hostHeader": "bridge-host.your-tailnet.ts.net:8450", "token": "..." }`. Optional `"cnyToEur": 0.13` adds approximate euro prices.

### 3. Hermes skill

```sh
mkdir -p ~/.hermes/skills/productivity/taobao-search
cp skill/SKILL.md ~/.hermes/skills/productivity/taobao-search/
```

## Usage

```sh
taobao search "typec 数据线 双头 快充" --sort sales --limit 8 --images
taobao status | login [--force] | login --wait | resume [--force] | pause
```

- `--sort relevance|sales|price_asc`. Taobao search has no rating sort.
- `--platform mixed|all|tmall|taobao`. The default is `mixed`: sorting by sales returns about 90% Tmall, so mixed keeps the ranking but reserves about half the slots for regular Taobao sellers.
- `--limit` (max 20), `--page` (max 2), `--min-price/--max-price` (CNY), `--ads`.
- `--images` downloads 400×400 images and converts WebP to JPEG (needs `python3` with Pillow) for chat apps.

Output is JSON: `{"ok":true,"data":{query,searchUrl,items,platformCountsOnPage,...},"meta":{cached,remainingToday}}` or `{"ok":false,"error":{code,message,retryable,retryAfterSec,action}}`.
Exit codes: 2 login_required, 3 captcha_required, 4 rate_limited, 5 bridge_unreachable, 6 paused, 7 unauthorized, 8 upstream_changed.

## How it stays gentle with Taobao

- Default budget: 60 Taobao calls a day (in China time), 6–12 s between calls with jitter, concurrency 1, 45-minute cache. A new query costs 1 call, or 2 when it needs a non-default sort.
- On a slider captcha the bridge **stops**, returns the web view link, and **detaches from Chromium** until `resume`. A human drag fails while an automation client is attached over CDP. After a captcha it runs at half speed for 24 h. A second captcha in a day needs `resume --force` and a cooldown.
- Login expiry is detected. `taobao login` returns a fresh QR (PNG) that the agent can send to you.

Findings that are useful elsewhere:

- The search API is `mtop.relationrecommend.wirelessrecommend.recommend` v2.0, appId `34385`.
- The real sort values are `_coefp` (relevance), `_sale` (sales) and `_bid` (price ascending). `sort=` in the URL is ignored.
- Browsers with `navigator.webdriver=true` always fail the slider.

## Tests

```sh
cd bridge && npm install && npm test
```

## License

MIT
