/**
 * 微信视频号取数：两步。
 *
 *   1) 腾讯元宝解析  POST https://yuanbao.tencent.com/api/weixin/get_parse_result
 *        需要**登录 Cookie**。返回里有两个关键字段：
 *          - wx_export_id
 *          - playable_url  ← 视频号自己的预览地址，query 里带着 token 和 eid
 *
 *   2) 视频号取 feed  POST https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info
 *        body: { baseReq: { generalToken }, exportId }
 *        Referer 里要带上面那个 token / eid，否则拿不到媒体列表。
 *        返回 data.feedInfo.h264VideoInfo.videoUrl / h265VideoInfo.videoUrl 就是可直下的地址。
 *
 * 为什么非要绕元宝：视频号自己的预览页（weixin.qq.com/sph/xxx）只会显示
 * 「可扫码前往微信观看此内容」，不返回任何媒体地址，实测 exportId 直连会得到
 * `{"errMsg":{"type":2,"title":"此内容暂时无法播放"}}`。元宝那边换出来的 token
 * 才是被授权的，带着它去问 feed_info 才给媒体。
 *
 * 参考实现：ltaoo/wx_channels_download 仓库 internal/workers/sph/worker.js（MIT）。
 */

import { withRetry } from '../util.js';

export const YUANBAO_PARSE_URL = 'https://yuanbao.tencent.com/api/weixin/get_parse_result';
export const CHANNELS_FEED_URL = 'https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info';
export const CHANNELS_HOST = 'channels.weixin.qq.com';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// 元宝这套头是服务端校验的一部分，缺了会被判成非预期客户端。
const YUANBAO_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'content-type': 'application/json',
  origin: 'https://yuanbao.tencent.com',
  referer: 'https://yuanbao.tencent.com/chat/naQivTmsDa/cf4d0079-ed1b-4c55-a3f3-2ca1379727d1',
  'user-agent': UA,
  'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'x-agentid': 'naQivTmsDa/cf4d0079-ed1b-4c55-a3f3-2ca1379727d1',
  'x-instance-id': '5',
  'x-language': 'zh-CN',
  'x-platform': 'mac',
  'x-requested-with': 'XMLHttpRequest',
  'x-source': 'web',
  'x-web-third-source': 'main',
  'x-webdriver': '0',
  'x-webversion': '2.69.0',
};

const FEED_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Content-Type': 'application/json',
  Origin: 'https://channels.weixin.qq.com',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': UA,
  'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
};

export class ChannelsError extends Error {
  constructor(message, code = 'CHANNELS_ERROR') {
    super(message);
    this.name = 'ChannelsError';
    this.code = code;
  }
}

/** 作品存在但当前不可播（已删除 / 仅限特定场景 / 直播回放未生成等）。 */
export class ChannelsUnavailableError extends ChannelsError {
  constructor(detail = {}) {
    const title = plainTextFromHtml(detail.title) || '视频无法播放';
    const content = plainTextFromHtml(detail.content);
    super(content ? `${title}：${content}` : title, 'FEED_UNAVAILABLE');
    this.name = 'ChannelsUnavailableError';
    this.detail = { type: Number(detail.type) || 0, title, content };
  }
}

function decodeHtmlEntities(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent) => {
    const n = ent.toLowerCase();
    let cp = null;
    if (n.startsWith('#x')) cp = Number.parseInt(n.slice(2), 16);
    else if (n.startsWith('#')) cp = Number.parseInt(n.slice(1), 10);
    if (cp !== null) return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    return named[n] ?? m;
  });
}

function plainTextFromHtml(value) {
  return decodeHtmlEntities(String(value ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** `_rid` 只是请求标识，用于日志串联。格式是「秒级时间戳 hex + 8 位随机 hex」。 */
export function generateRid(now = Date.now()) {
  const ts = Math.floor(now / 1000).toString(16);
  let rand = '';
  for (let i = 0; i < 8; i++) rand += '0123456789abcdef'[Math.floor(Math.random() * 16)];
  return `${ts}-${rand}`;
}

/* eslint-disable no-undef */
const defaultFetch = (...args) => globalThis.fetch(...args);

async function postJson(url, { headers, body, timeoutMs = 15000, fetchImpl = defaultFetch }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON，下面统一报错 */ }
    return { status: resp.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 第一步：让元宝把分享链接换成「可播地址」。
 * @returns {{exportId: string, generalToken: string, playableUrl: string, parse: object}}
 */
export async function parseShareUrl(shareUrl, {
  cookie,
  timeoutMs = 15000,
  fetchImpl = defaultFetch,
} = {}) {
  if (!cookie) throw new ChannelsError('缺少元宝 Cookie', 'NEED_COOKIE');

  let out;
  try {
    out = await postJson(YUANBAO_PARSE_URL, {
      headers: { ...YUANBAO_HEADERS, cookie },
      body: { type: 'video_channel_url', url: shareUrl, scene: 1 },
      timeoutMs,
      fetchImpl,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw new ChannelsError(`元宝解析超时（${timeoutMs}ms）`, 'TIMEOUT');
    throw new ChannelsError(`元宝解析请求失败：${e.message}`, 'NETWORK');
  }

  if (out.status === 401) {
    const code = String(out.json?.error?.code || '');
    const msg = out.json?.error?.message || '未授权';
    // 20001 = token 无效（Cookie 过期/不完整）；20000 = 压根没带有效凭据
    const hint = code === '20001'
      ? '元宝 Cookie 已失效，请重新登录 yuanbao.tencent.com 再复制一次'
      : '元宝 Cookie 无效或缺失，请检查是否复制了完整的 Cookie 头';
    throw new ChannelsError(`元宝拒绝了这次请求：${msg}（${hint}）`, 'COOKIE_INVALID');
  }
  // 注意：这个端点正常也回 201（不是 200），别只认 200
  if (out.status < 200 || out.status >= 300 || !out.json) {
    throw new ChannelsError(`元宝解析返回异常：HTTP ${out.status}`, 'UPSTREAM');
  }

  const data = out.json.data;
  if (!data) {
    throw new ChannelsError(`元宝解析没有返回数据：${out.text.slice(0, 200)}`, 'UPSTREAM');
  }
  if (!data.wx_export_id) {
    throw new ChannelsError('元宝解析结果里没有 wx_export_id', 'UPSTREAM');
  }

  const { generalToken, exportId } = extractTokenAndEid(data.playable_url);
  return { exportId, generalToken, playableUrl: data.playable_url || '', parse: data };
}

/**
 * 从元宝给的 playable_url 里抠出 token / eid。
 * eid 就是后面要用的 exportId（形如 `export/UzFfBgAA...`，链接里是 URL 编码的）。
 */
export function extractTokenAndEid(playableUrl) {
  if (!playableUrl) return { generalToken: '', exportId: '' };
  try {
    const u = new URL(playableUrl);
    return {
      generalToken: u.searchParams.get('token') || '',
      exportId: u.searchParams.get('eid') || '',
    };
  } catch {
    return { generalToken: '', exportId: '' };
  }
}

/**
 * 第二步：带 token 去视频号取 feed。
 * @returns {object} 原始响应 JSON
 */
export async function fetchFeedInfo(exportId, generalToken, {
  timeoutMs = 15000,
  fetchImpl = defaultFetch,
  retries = 2,
} = {}) {
  if (!exportId) throw new ChannelsError('缺少 exportId（playable_url 里没有 eid）', 'UPSTREAM');

  const pageUrl = encodeURIComponent(`https://${CHANNELS_HOST}/finder-preview/pages/feed`);
  const apiUrl = `${CHANNELS_FEED_URL}?_rid=${generateRid()}&_pageUrl=${pageUrl}`;
  const referer = `https://${CHANNELS_HOST}/finder-preview/pages/feed`
    + '?entry_card_type=48&comment_scene=39&appid=0'
    + `&token=${encodeURIComponent(generalToken)}`
    + `&entry_scene=0&eid=${encodeURIComponent(exportId)}`;

  const out = await withRetry(async () => {
    const r = await postJson(apiUrl, {
      headers: { ...FEED_HEADERS, Referer: referer },
      body: { baseReq: { generalToken }, exportId },
      timeoutMs,
      fetchImpl,
    });
    if (r.status >= 500) throw new ChannelsError(`视频号接口 HTTP ${r.status}`, 'UPSTREAM');
    return r;
  }, { retries, onRetry: () => {} });

  // 实测这个端点回的是 201 Created，不是 200 —— 只认 200 会直接把正常响应判失败
  if (out.status < 200 || out.status >= 300 || !out.json) {
    throw new ChannelsError(`视频号接口返回异常：HTTP ${out.status}`, 'UPSTREAM');
  }

  const json = out.json;
  const errCode = Number(json.errCode) || 0;
  if (errCode !== 0) {
    throw new ChannelsError(`视频号接口报错 errCode ${errCode}：${plainTextFromHtml(json.errMsg)}`, 'UPSTREAM');
  }

  // errMsg 有内容 = 作品不可播（已删/受限），不是 bug，别重试
  const detail = json.data?.errMsg;
  if (detail && typeof detail === 'object') {
    const hasError = Number(detail.type) !== 0
      || plainTextFromHtml(detail.title) !== ''
      || plainTextFromHtml(detail.content) !== '';
    if (hasError) throw new ChannelsUnavailableError(detail);
  }

  return json;
}

/**
 * 两步串起来：输入分享链接 → 归一化 → 拿 feed。
 * @returns {{feed: object, sphId: string, url: string, resolvedFrom: string, exportId: string}}
 */
export async function fetchChannelsFeed(input, {
  cookie,
  timeoutMs = 15000,
  fetchImpl = defaultFetch,
  retries = 2,
  logger = null,
  resolved = null,
} = {}) {
  const r = resolved || (await import('./resolve.js')).extractSphId(input);
  if (!r) throw new ChannelsError('无法从输入里识别出视频号分享链接', 'RESOLVE_FAILED');

  logger?.info?.(`视频号 ${r.sphId}（${r.resolvedFrom}）`);
  const parsed = await parseShareUrl(r.url, { cookie, timeoutMs, fetchImpl });
  const feed = await fetchFeedInfo(parsed.exportId, parsed.generalToken, { timeoutMs, fetchImpl, retries });

  return {
    feed,
    sphId: r.sphId,
    url: r.url,
    resolvedFrom: r.resolvedFrom,
    exportId: parsed.exportId,
    generalToken: parsed.generalToken,
  };
}
