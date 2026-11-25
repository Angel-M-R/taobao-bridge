// Turns Taobao's raw search items into the stable shape the CLI and Hermes rely on.
// Seller-provided text (titles, shop names) is untrusted: we strip markup, collapse
// whitespace and truncate it so it cannot smuggle instructions or huge payloads.

const MAX_TEXT = 120;

export function cleanText(value, max = MAX_TEXT) {
  if (value == null) return null;
  const text = String(value)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function toNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && String(value).match(/\d/) ? n : null;
}

// "1万+人付款" -> 10000, "2000+人收货" -> 2000, "46人付款" -> 46. Always a lower bound.
export function parseSalesMin(text) {
  if (!text) return null;
  const m = String(text).match(/([\d.]+)\s*(万|千)?/);
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return null;
  const mult = m[2] === '万' ? 10000 : m[2] === '千' ? 1000 : 1;
  return Math.round(base * mult);
}

const PRICE_LABELS = [
  [/券后|优惠后|折后/, 'after_discount'],
  [/补贴/, 'subsidy'],
  [/到手/, 'final'],
];

export function priceLabel(text) {
  if (!text) return null;
  for (const [re, label] of PRICE_LABELS) if (re.test(text)) return label;
  return 'other';
}

export function absoluteUrl(url) {
  if (!url) return null;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('http://')) return `https://${url.slice(7)}`;
  return url;
}

function platformOf(item) {
  const url = item.auctionURL || '';
  if (/tmall\.com/.test(url)) return 'tmall';
  if (/taobao\.com/.test(url) && !/click\.simba/.test(url)) return 'taobao';
  const tag = item.shopInfo?.indTagText || '';
  if (/天猫/.test(tag)) return 'tmall';
  return 'taobao';
}

function badgesOf(item) {
  const out = new Set();
  for (const icon of item.icons || []) {
    const t = cleanText(icon?.alt || icon?.text || icon?.title, 20);
    if (t) out.add(t);
  }
  return [...out];
}

export function normalizeItem(item) {
  const id = item.item_id != null ? String(item.item_id) : null;
  if (!id) return null;
  const platform = platformOf(item);
  const current = toNumber(item.priceShow?.price ?? item.price);
  const listed = toNumber(item.price);
  const salesText = cleanText(item.realSales, 40);
  const labelText = cleanText(item.priceShow?.priceDesc, 20);
  return {
    id,
    title: cleanText(item.title),
    url: platform === 'tmall'
      ? `https://detail.tmall.com/item.htm?id=${id}`
      : `https://item.taobao.com/item.htm?id=${id}`,
    platform,
    image: absoluteUrl(item.pic_path),
    price: {
      current,
      original: listed != null && current != null && listed > current ? listed : null,
      currency: 'CNY',
      label: priceLabel(labelText),
      labelText,
    },
    sales: { min: parseSalesMin(salesText), text: salesText },
    shop: {
      name: cleanText(item.shopInfo?.title || item.nick, 60),
      type: cleanText(item.shopInfo?.indTagText, 20),
    },
    location: cleanText(item.procity, 30),
    badges: badgesOf(item),
    isAd: item.isP4p === 'true' || item.isP4p === true || /click\.simba/.test(item.auctionURL || ''),
  };
}

export class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.code = 'upstream_changed';
  }
}

// Validates the raw mtop payload and returns normalized items plus paging info.
export const PLATFORMS = ['mixed', 'all', 'tmall', 'taobao'];

// `mixed`: keep the ranking but reserve about half of the slots for each platform
// (sales sorting is dominated by Tmall, which hides individual Taobao sellers).
function pickMixed(items, limit) {
  const target = Math.ceil(limit / 2);
  const tm = items.filter((x) => x.platform === 'tmall');
  const tb = items.filter((x) => x.platform !== 'tmall');
  const takeTb = Math.min(tb.length, Math.max(target, limit - tm.length));
  const takeTm = Math.min(tm.length, limit - takeTb);
  const chosen = new Set([...tm.slice(0, takeTm), ...tb.slice(0, takeTb)]);
  return items.filter((x) => chosen.has(x));
}

export function normalizeSearch(raw, { includeAds = false, limit = 5, tmallOnly = false, platform = 'all' } = {}) {
  const data = raw?.data;
  if (!data || !Array.isArray(data.itemsArray)) {
    throw new SchemaError('Search response has no itemsArray; Taobao may have changed the format.');
  }
  const all = data.itemsArray.map(normalizeItem).filter(Boolean);
  if (data.itemsArray.length > 0 && all.length === 0) {
    throw new SchemaError('Search items have no item_id; Taobao may have changed the format.');
  }
  let items = all;
  if (!includeAds) items = items.filter((x) => !x.isAd);
  if (tmallOnly) platform = 'tmall';
  const platformCounts = {
    tmall: items.filter((x) => x.platform === 'tmall').length,
    taobao: items.filter((x) => x.platform !== 'tmall').length,
  };
  if (platform === 'tmall') items = items.filter((x) => x.platform === 'tmall');
  if (platform === 'taobao') items = items.filter((x) => x.platform !== 'tmall');
  const matchedOnPage = items.length;
  items = platform === 'mixed' ? pickMixed(items, limit) : items.slice(0, limit);
  const info = data.mainInfo || {};
  const page = toNumber(info.page) ?? 1;
  const totalPages = toNumber(info.totalPage);
  return {
    items,
    returnedCount: items.length,
    matchedOnPage,
    platformCounts,
    rawCountOnPage: data.itemsArray.length,
    page,
    hasMore: totalPages != null ? page < totalPages : data.itemsArray.length > 0,
    totalResultsApprox: toNumber(info.totalResults),
  };
}

// Classifies an mtop `ret` array into our error codes.
export function classifyRet(ret) {
  const text = (Array.isArray(ret) ? ret : [ret]).join(' ');
  if (/^SUCCESS/.test(text)) return 'ok';
  if (/FAIL_SYS_USER_VALIDATE|RGV587_ERROR|FAIL_SYS_ILLEGAL_ACCESS|punish/i.test(text)) return 'captcha_required';
  if (/FAIL_SYS_SESSION_EXPIRED|ERR_SID_INVALID|FAIL_SYS_LOGIN|SESSION_EXPIRED/i.test(text)) return 'login_required';
  if (/FAIL_SYS_TOKEN_EXOIRED|FAIL_SYS_TOKEN_EXPIRED|FAIL_SYS_TOKEN_EMPTY|ILLEGAL_REQUEST/i.test(text)) return 'token_expired';
  if (/FAIL_SYS_FLOWLIMIT|FAIL_SYS_TRAFFIC_LIMIT/i.test(text)) return 'upstream_busy';
  return 'upstream_error';
}
