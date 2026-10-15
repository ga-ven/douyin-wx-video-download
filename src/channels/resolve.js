/**
 * 微信视频号：把各种形态的分享链接归一化成 sph 短 id。
 *
 * 支持的输入：
 *   https://weixin.qq.com/sph/A6e7uGh8J8                    ← 最常见的分享短链
 *   https://channels.weixin.qq.com/finder-preview/pages/sph?id=A6e7uGh8J8
 *   A6e7uGh8J8                                               ← 裸 id
 *   一整段分享文案（里面夹着上面任意一种链接）
 *
 * 注意 `weixin.qq.com/sph/xxx` 不是 302 跳转，而是直接返回一个 SPA 壳，
 * 真正的数据由 JS 去调 `finder-preview/api/feed/get_feed_info` 拿。
 * 所以这里只负责把 id 抠出来，取数在 feed.js。
 */

const SPH_HOST = 'channels.weixin.qq.com';
export const SPH_PREVIEW_URL = `https://${SPH_HOST}/finder-preview/pages/sph`;

// sph 短 id：base62 风格，实测 10 位左右；放宽到 6~64 以兼容未来变化
const SPH_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

/** 从一整段文本里捞出第一个 http(s) 链接。 */
function firstUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>）)】]+/i);
  return m ? m[0] : '';
}

/** 是不是「裸 sph id」（既不是 URL，也不是纯数字——纯数字归抖音）。 */
export function isBareSphId(input) {
  const s = String(input ?? '').trim();
  if (!s || /^\d+$/.test(s)) return false;
  return SPH_ID_RE.test(s);
}

/**
 * 从任意输入里提取 sph id。
 * @returns {{sphId: string, url: string, resolvedFrom: string}|null}
 */
export function extractSphId(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  // 1) 裸 id
  if (isBareSphId(raw)) {
    return { sphId: raw, url: `${SPH_PREVIEW_URL}?id=${raw}`, resolvedFrom: '裸 id' };
  }

  const url = firstUrl(raw) || raw;
  let u;
  try {
    u = new URL(url.startsWith('http') ? url : `https://${url}`);
  } catch {
    return null;
  }

  const host = u.hostname.toLowerCase();

  // 2) weixin.qq.com/sph/<id> 或 /sph/<id>?...
  const m = u.pathname.match(/\/sph\/([A-Za-z0-9_-]+)/);
  if (m && /(^|\.)weixin\.qq\.com$/.test(host)) {
    return { sphId: m[1], url: `${SPH_PREVIEW_URL}?id=${m[1]}`, resolvedFrom: 'weixin.qq.com/sph 短链' };
  }

  // 3) finder-preview/pages/sph?id=<id>
  if (/(^|\.)channels\.weixin\.qq\.com$/.test(host) && /\/sph\b/.test(u.pathname)) {
    const id = u.searchParams.get('id');
    if (id && SPH_ID_RE.test(id)) {
      return { sphId: id, url: `${SPH_PREVIEW_URL}?id=${id}`, resolvedFrom: 'channels.weixin.qq.com 预览页' };
    }
  }

  return null;
}
