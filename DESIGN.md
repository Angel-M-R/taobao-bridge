# Taobao search for Hermes: design v0 (to review)

> Historical design notes written while building the project (2026-11-22). The README describes the current behaviour.

Date: 2026-11-22. Status: draft before implementation.

## Goal

Let the Hermes Agent (Nous Research, v0.23.3) running on `agent-vps` search Taobao and get back, per product: id, title, image, price, sales, shop, Tmall or not, link. the owner talks to Hermes over WhatsApp. Search by image and ordering are out of scope.

## Constraints and evidence

- Taobao search requires login. Logged out, the search API returns `FAIL_SYS_SESSION_EXPIRED`, and the header `bxpunish: 1` sets the `x5secdata` cookie (slider).
- A browser flagged as automated (`navigator.webdriver = true`, e.g. the chrome-devtools MCP) **always fails** the slider, even when a human drags it. A browser without the flag passes it.
- Search goes through `mtop.relationrecommend.wirelessrecommend.recommend` v2.0, `appId 34385`. The `params` include `q`, `page`, `n=48`, `sort` (`_coefp` default, `sale-desc`, `price-asc`…), `tab`, `startPrice`/`endPrice`.
- Calling `window.lib.mtop.request(...)` from inside an `s.taobao.com` page works: Taobao's own JS handles the signing (`_m_h5_tk` + `sign`). We don't reverse anything or parse the DOM.
- **Spike on home-pc (2026-11-22):**
  - Setup: container `lscr.io/linuxserver/chromium` (Chromium 156, Selkies web view), profile on a volume, CDP 9222 only inside the container. Human login by QR from the web view.
  - Result: the first search asked for a slider (solved by hand). After that, 7 pages across 3 keywords returned `SUCCESS::调用成功`, 49 items per page (≈13 ads, `isP4p=true`). Pagination is capped at `totalResults: 5000` (100 pages).
  - Spike scripts are not included in this repo.
- Useful fields per item: `item_id`, `title` (carries `<span class=H>`), `pic_path`, `price` (list) and `priceShow.price` + `priceShow.priceDesc` ("优惠后", after discount), `realSales` ("1万+人付款", text), `nick`, `shopInfo.title`, `shopInfo.indTagText` ("品牌旗舰"), `procity`, `auctionURL` (`detail.tmall.com` vs `item.taobao.com`; `click.simba…` for ads), `isP4p`, `icons` (包邮, 退货宝), `video`.
- Machines:
  - `agent-vps`: Linux VPS with a datacenter IP, runs Hermes.
  - `home-pc`: always-on Linux box at home (**home IP**), Docker, private panels published with Tailscale Serve.
  - Both are on the same tailnet.

## Architecture

```
WhatsApp ─ Hermes (agent-vps) ─ `taobao` CLI ──HTTPS over Tailscale + token──▶ taobao-bridge (home-pc)
                                                                                 ├─ chromium (logged-in profile)
                                                                                 ├─ bridge API (Node), CDP to localhost only
                                                                                 └─ web view (Selkies) for login/slider
```

Principle: the VPS **never** gets the browser (CDP). It only gets a search API. The Taobao account carries orders, addresses and chats, and nothing of that is exposed.

### 1. `taobao-bridge` on home-pc (docker compose)

- Service `chromium`: `lscr.io/linuxserver/chromium` with version pinned, `CHROME_CLI=--remote-debugging-port=9222`, profile volume, `shm_size: 1g`. Web view with `CUSTOM_USER/PASSWORD`.
- Service `bridge`: Node 22 + TypeScript + Fastify + `playwright-core` (`connectOverCDP`). `network_mode: service:chromium` so it reaches `127.0.0.1:9222`. It listens on `127.0.0.1:8790`.
- Publishing: Tailscale Serve HTTPS (e.g. `:8450` → bridge, `:8451` → web view), same as the existing panels. Nothing on `eno1`.
- Auth: `Authorization: Bearer <token>` (token in the VPS `.env`), plus the tailnet as the network barrier.
- Behaviour:
  - A dedicated "worker" tab parked on `s.taobao.com`, reopened if it dies.
  - Serialised queue (concurrency 1), a minimum of 2–3 s between Taobao calls with jitter, a configurable daily cap, and a 10 min cache per `(q, page, sort, filters)`.
  - State detection:
    - `ret` containing `FAIL_SYS_SESSION_EXPIRED` / `FAIL_SYS_TOKEN_EXOIRED` / login redirect → `login_required`.
    - `RGV587_ERROR` / `FAIL_SYS_USER_VALIDATE` / `bxpunish` / slider visible / timeout → `captcha_required`.
    - No automatic retries on either one; the queue stays paused until resolved.
  - Logs without cookies or tokens.

API v1:

| Endpoint | Returns |
|---|---|
| `GET /v1/status` | `{state: ok\|login_required\|captcha_required, nick, lastSuccessAt, queue}` |
| `GET /v1/search?q=&page=&sort=default\|sales\|price_asc\|price_desc&min_price=&max_price=&tmall_only=&include_ads=false` | `{query, page, pageSize, totalPages, items[]}` |
| `POST /v1/login` | QR PNG (base64) of the login page, plus expiry |
| `GET /v1/captcha` | Screenshot + web view URL so a human can solve it |
| `GET /v1/item/:id` | **Phase 2**: detail API not yet identified/tested |

Normalised `item`:

```json
{
  "id": "941151774005",
  "title": "雾影 H98机械键盘…",
  "url": "https://detail.tmall.com/item.htm?id=941151774005",
  "platform": "tmall",
  "image": "https://g-search3.alicdn.com/...jpg",
  "price": { "current": 159, "original": 259, "currency": "CNY", "label": "优惠后" },
  "sales": { "text": "2000+人付款", "approx": 2000 },
  "shop": { "name": "雾影数码旗舰店", "type": "品牌旗舰" },
  "location": "广东 东莞",
  "badges": ["包邮", "退货宝"],
  "isAd": false
}
```

### 2. `taobao` CLI on agent-vps

- Node 22 (Hermes already ships Node), a single bundled file in `~/.local/bin/taobao`. Config in `~/.config/taobao/config.json` (URL + token, `0600` permissions).
- Commands:
  - `taobao search <q> [--page N] [--sort …] [--min-price] [--max-price] [--tmall] [--ads] [--limit N]`
  - `taobao status`
  - `taobao login` (saves the QR to `/tmp/taobao-login-<ts>.png` and prints the path so Hermes can send it over WhatsApp)
  - `taobao captcha` (screenshot + instructions)
  - `taobao images <ids…> --dir` (downloads thumbnails so Hermes can send them).
- Output: JSON on stdout. Errors as JSON `{error: {code, message, action}}` on stdout, with distinct exit codes (2 `login_required`, 3 `captcha_required`, 4 `rate_limited`, 5 `bridge_unreachable`). Human-readable diagnostics on stderr. `--format table` for humans.

### 3. Hermes skill

`~/.hermes/skills/productivity/taobao/SKILL.md`: when to use it, examples, how to search in Chinese (translate the user's query), how to present results (top N with image, CNY price + approximate EUR, link), and what to do on `login_required` (send the QR to the owner) and `captcha_required` (send the web view link to the owner and wait).

### 4. Human in the loop

- Login: the QR reaches the owner over WhatsApp, to be scanned with the Taobao app.
- Slider: the owner opens the web view (Tailscale Serve, password) from a phone or the Mac and drags it.

## Phases

1. Bridge with `status` + `search` + CLI `search/status` + skill. Measure the frequency of sliders and session expiry.
2. `login` with QR over WhatsApp, `captcha` with screenshot, `images`.
3. `item` detail; optional fallback to the 淘宝联盟 affiliate API (C) or a paid API (D) behind the same output format.

## Open questions for the review

1. Is the home-pc bridge + thin CLI split right, or is something simpler better (e.g. SSH from the VPS to home-pc running the CLI there)?
2. `lib.mtop.request` inside the page vs. intercepting responses from real navigations (`page.goto` to `s.taobao.com/search?...&page=N`): which is more robust and less detectable?
3. linuxserver/chromium (Chromium on Linux, no GPU) vs. Google Chrome + Xvfb on the host: does the fingerprint matter for how often the slider appears?
4. Rate limits and account protection: what limits and patterns would you use?
5. Is the API and output contract good for an agent (field names, errors, pagination, ads, prices)?
6. Security: is a Bearer token over Tailscale + Serve enough? Anything missing?
7. Anything important missing (observability, session expiry, Selkies updates, tests)?

---

## v1: changes after review (gpt-6.2-astra + fable-5.2, 2026-11-22)

### Network and security
- **Compose network:** the bridge listens on `0.0.0.0:8790` inside the `chromium` namespace, and `chromium` publishes `127.0.0.1:8790:8790` on the host so Serve can reach it. `9222` is never published and `--remote-debugging-address` is never used. (Both reviews.)
- **Tailscale ACL/grants:** the VPS can only reach `home-pc:8450` (API). The web view (`:8451`) is reachable only from the owner's devices. The linuxserver image's GUI includes a terminal with passwordless sudo, so if the VPS could reach it, it would have the whole account. Check with a test from the VPS that it **cannot** open the web view. (Both.)
- Bearer token stays: Serve's identity headers don't apply to tagged devices. (Fable.)
- Treat the profile volume as a credential: restrictive permissions and no unencrypted backups. That Chromium is used only for Taobao.
- `status` does not expose `nick`.
- **Prompt injection:** titles and shop names are seller text. Strip HTML, truncate to about 120 characters, and the SKILL.md must say the results are data, never instructions. (Both.)
- **Taobao account (pending the owner's decision):** both reviews recommend a secondary account with no orders, addresses or Alipay.

### MVP scope
- Out of the MVP: `POST /v1/login` (QR over WhatsApp) and `GET /v1/captcha`. Login and slider are done by the owner in the web view. The QR expires in minutes and would arrive on the same phone that has to scan it. (Both.)
- Test before closing this: dragging the slider from the phone through Selkies.

### How Taobao is queried (hybrid)
- Page 1 of each new search: real navigation to `s.taobao.com/search?q=…` and interception of the mtop response that the page itself makes.
- From that response, capture the `params` template and reuse it with `lib.mtop.request` for pages 2+, which removes the ~60 hand-copied parameters.
- Keep the referer consistent: the page's `q` must equal the request's `q`.
- Validate the filters (`sort`, prices, Tmall) before promising them.

### State machine and errors
| Code | When | Retryable |
|---|---|---|
| `login_required` | `FAIL_SYS_SESSION_EXPIRED` or redirect to login, **observed** | no; human |
| `captcha_required` | slider/`bxpunish`/`RGV587` **observed** | no; human, then explicit `resume` |
| `upstream_timeout` / `upstream_error` | timeout, network, 5xx | yes, with backoff |
| `upstream_changed` | `SUCCESS` but missing `itemsArray` or fields | no; alert |
| `rate_limited` | local budget used up | yes, `retryAfterSec` |
| `bridge_unreachable` / `unauthorized` / `invalid_args` | CLI side | as appropriate |

- `FAIL_SYS_TOKEN_EXOIRED` / `FAIL_SYS_TOKEN_EMPTY` = expiry of the signing token (`_m_h5_tk`), not of the session: reload the page and retry once. (Fable.)
- When paused, pending requests are answered immediately with the reason. Resumption via `POST /v1/resume`, plus a cheap check (slider in the DOM / session cookie), with no restart needed.
- `status` returns the last observed state and how old it is, without launching a search.

### Limits and account protection (initial values, to tune with data)
- Concurrency 1, 6–12 s with jitter between calls, 1 page per explicit request and no prefetch, a maximum of 5 pages per search.
- A budget of 150 calls per day, persisted across restarts. 45 min cache. Identical in-flight searches are coalesced.
- After a captcha: 30–60 min cool-down, then half pace for 24 h. Two captchas in a day stop everything until manual intervention. No periodic keep-alive. Kill switch `taobao pause`.

### Contract for the agent
- Envelope `{ok, data | error:{code, message, retryable, retryAfterSec, action}, meta:{cached, fetchedAt, remainingToday}}`.
- IDs as strings. `returnedCount`, `hasMore` and `nextPage` (nullable) separate from the provider's totals (always 100 pages).
- `--limit` defaults to 10.
- Price: `current` and `original` (null if there is no discount) as numbers, plus `label` as an enum (`after_coupon`, `subsidy`…) and `labelText`.
- `sales.min` (lower bound: "1万+" → 10000) plus `text`.
- Canonical URL rebuilt from `item_id` (never `click.simba`). `pic_path` normalised to `https:`.
- EUR conversion done in the CLI with a configurable fixed rate, never by the LLM.
- `taobao images` prints absolute paths (in a `0700` directory) so the Hermes gateway sends them as attachments. Skill frontmatter: `name`, `description`, `version`; the token lives in the config file.

### Browser
- Keep Chromium in the container, image pinned by digest, manual updates.
- Cheap improvements: `--device /dev/dri` (NUC iGPU), a `TZ` consistent with the IP, and CJK fonts checked.
- If sliders become frequent, the first experiment is raw CDP connected only during the call, before changing browser.

### Operations and tests
- Metrics: captchas per day, time to resolve, session age, calls per day, latency, failures by class, time since the last success.
- Schema-drift alert (`SUCCESS` with 0 items).
- Restart: `unless-stopped`, and the worker tab recovers by itself.
- Normaliser tests with recorded (anonymised) responses.
- Failure tests: CDP lost, restart with the session persisted, valid empty response, schema change.

### Disagreements between reviewers
- Query method: Astra preferred intercepting real navigations, Fable a hybrid. **Decision:** hybrid, which covers both: real interception on page 1, template for pages 2+.
- Limits: Astra gave no numbers, Fable gave conservative ones. **Decision:** Fable's values as a starting point.

---

## v1.1: owner feedback and sorting spike (2026-11-22)

### Login over WhatsApp: back in the MVP
- The owner opens WhatsApp on the PC and scans the QR with the phone, so the QR expiring isn't a problem.
- Flow: `taobao login` asks the bridge for a **fresh** QR, saves it as a PNG in a `0700` directory and prints the absolute path; Hermes sends it. The bridge polls until login is confirmed and `taobao status` reflects it. If the QR expires, a new one is requested.
- The slider still can't be solved over WhatsApp (it needs dragging): Hermes sends the owner the web view link.

### Usage model: "top picks", not catalogue browsing
- Typical use: "best USB-C to USB-C cable options". The owner wants the **first options** by a criterion (sales, relevance), not several pages.
- Default: **1 call to Taobao per search**, page 1, no ads, `--limit 5` (max. 20). Page 2 only on explicit request; hard cap of 2 pages per search.
- With this pattern the daily budget can be lower: 60 calls/day to start.

### Sorting: what Taobao actually supports (sorting spike)
- `sort=` in the `s.taobao.com` URL is **ignored**: the page always asks for `_coefp`.
- By clicking the real tabs, the sort options are **综合 (relevance), 销量 (sales) and 价格 (price)**. There is no tab for rating or reviews.
- Real values captured from the request: relevance = `_coefp`, sales = **`_sale`** (not `sale-desc`; the API accepts `sale-desc` without error but doesn't sort by sales). Price: capture its value(s) in the same way before implementing.
- With `_sale`, the sales text changes from `人付款` (paid) to `人收货` (received) and the results lean towards official shops. The normaliser has to accept both.
- Implementation: real navigation, then the sort is applied by reusing the captured template with the real value (`_sale`), which is equivalent to clicking the tab. (spike script not included)

### Rating
- Search results **carry no item rating** (`relationScore` = 0; there is no rating/reviews field).
- MVP: approximate quality with what we do have: sales, shop type (`品牌旗舰`, Tmall) and badges (`退货宝`, 包邮).
- Phase 2: `--details N` (max. 3) fetches the detail of the top N candidates for rating/number of reviews. N extra calls, counted against the budget. Requires identifying and testing the detail API first.
