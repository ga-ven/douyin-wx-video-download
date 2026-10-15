/**
 * 抖音 App Feed 接口客户端。
 *
 * 这是整个项目的核心：**一条 GET 请求**拿到作品的全部元信息与所有档位的 mp4 直链。
 *
 * 端点是抖音**手机客户端**在用的接口，不是网页版接口，所以：
 *   - 不需要 cookie
 *   - 不需要 a_bogus / X-Gorgon 之类的签名
 *   - 不会被 ArgusSecurityPlugin 拦（网页版接口会回 403）
 *
 * 唯一的门槛是 User-Agent：必须伪装成客户端。实测
 *   不带 UA          -> 60 字节空壳
 *   浏览器 UA        -> 83 字节空壳
 *   客户端 UA        -> 数百 KB 真实 JSON
 */

import { withRetry, sleep } from './util.js';

/** 抖音 Android 客户端 UA。版本号不必最新，能过校验即可。 */
export const APP_UA = 'com.ss.android.ugc.aweme/290101 (Linux; U; Android 12; zh_CN; SM-G988N; '
  + 'Build/SP1A.210812.016; Cronet/TTNetVersion:d1da0ea9 2023-01-13 QuicVersion:51879282 2022-12-07)';

/** 同一套接口的多个接入点，逐个降级。前两个实测最稳。 */
export const FEED_HOSTS = [
  'https://aweme.snssdk.com/aweme/v1/feed/',
  'https://aweme-hl.snssdk.com/aweme/v1/feed/',
  'https://api3-normal-c-hl.amemv.com/aweme/v1/feed/',
  'https://api5-normal-c-lq.amemv.com/aweme/v1/feed/',
  'https://api.amemv.com/aweme/v1/feed/',
];

/** 空壳响应的判据：HTTP 200 但 body 短得离谱，说明 UA 没骗过去或该 host 正限流。 */
const MIN_BODY_BYTES = 500;

async function requestOne(host, awemeId, { timeoutMs }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${host}?aweme_id=${awemeId}`, {
      headers: { 'User-Agent': APP_UA, Accept: 'application/json' },
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (text.length < MIN_BODY_BYTES) {
      throw new Error(`只回了 ${text.length} 字节的空响应（UA 未生效或该接入点限流）`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从 aweme_list 里挑出我们要的那条。
 * 接口会顺带返回若干相关推荐，所以必须按 id 精确匹配。
 */
export function pickAweme(data, awemeId) {
  const list = Array.isArray(data?.aweme_list) ? data.aweme_list : [];
  const hit = list.find((x) => String(x?.aweme_id) === String(awemeId));
  if (hit) return hit;
  // 极少数情况只回一条且就是它
  if (list.length === 1) return list[0];
  return null;
}

/**
 * 拉取作品详情。逐个 host 试，每个 host 内部再退避重试。
 *
 * @returns {Promise<{item: object, host: string, attempts: Array<{host:string, error:string}>}>}
 */
export async function fetchAweme(awemeId, {
  hosts = FEED_HOSTS,
  timeoutMs = 10000,
  retriesPerHost = 1,
  onHostError,
  onAttempt,
} = {}) {
  const attempts = [];
  for (const host of hosts) {
    try {
      const data = await withRetry(
        () => requestOne(host, awemeId, { timeoutMs }),
        {
          retries: retriesPerHost,
          delay: 600,
          onRetry: async () => { await sleep(0); },
        },
      );
      const item = pickAweme(data, awemeId);
      if (!item) throw new Error('该接入点返回数据但没有这条作品');
      if (onAttempt) onAttempt(host, true);
      return { item, host, attempts };
    } catch (e) {
      const msg = e?.name === 'AbortError' ? `超时(${timeoutMs}ms)` : (e?.message || String(e));
      attempts.push({ host, error: msg });
      if (onHostError) onHostError(host, msg);
    }
  }
  const detail = attempts.map((a) => `  ${a.host} -> ${a.error}`).join('\n');
  throw new Error(`所有接入点都没拿到数据：\n${detail}`);
}

/** 作品是不是图集（图文） */
export function isImagePost(item) {
  return Array.isArray(item?.images) && item.images.length > 0;
}

/** 从作品对象里抽出给用户看的元信息 */
export function describeAweme(item, awemeId) {
  const v = item?.video || {};
  const stats = item?.statistics || {};
  return {
    aweme_id: String(item?.aweme_id ?? awemeId),
    title: item?.desc || '',
    author: item?.author?.nickname || '',
    author_id: item?.author?.sec_uid || '',
    duration_sec: v.duration ? Number((v.duration / 1000).toFixed(3)) : null,
    created_at: item?.create_time ? new Date(item.create_time * 1000).toISOString() : null,
    is_image_post: isImagePost(item),
    image_count: isImagePost(item) ? item.images.length : 0,
    stats: {
      digg: stats.digg_count ?? null,
      comment: stats.comment_count ?? null,
      share: stats.share_count ?? null,
      play: stats.play_count ?? null,
    },
    page_url: `https://www.douyin.com/video/${item?.aweme_id ?? awemeId}`,
  };
}
