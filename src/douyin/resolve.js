/**
 * 把用户给的任意输入解析成 aweme_id。
 *
 * 支持：
 *   - 纯数字 id
 *   - v.douyin.com / www.douyin.com / m.douyin.com / iesdouyin.com 各类链接
 *   - 抖音「复制链接」带的一整段分享文案（链接混在中文里）
 *   - 没带协议的裸域名 v.douyin.com/xxxx
 */

const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

const ID_IN_PATH = /\/(?:video|note|slides)\/(\d{6,})/;
const BARE_ID = /^\d{6,}$/;

export function extractUrl(input) {
  const text = String(input ?? '').trim();
  if (!text) return '';
  // 从分享文案里抠链接
  const withProto = text.match(/https?:\/\/[^\s，。、）)】"']+/);
  if (withProto) return withProto[0].replace(/[.,;]+$/, '');
  // 裸域名
  const bare = text.match(/(?:v|www|m|iesdouyin)\.douyin\.com\/[^\s，。、）)】"']+/);
  if (bare) return `https://${bare[0].replace(/[.,;]+$/, '')}`;
  return '';
}

export function extractIdFromString(s) {
  if (!s) return '';
  const m = String(s).match(ID_IN_PATH) || String(s).match(/item_ids=(\d{6,})/);
  return m ? m[1] : '';
}

/**
 * @returns {Promise<{awemeId: string, resolvedFrom: string}>}
 */
export async function resolveAwemeId(input, { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('输入为空');

  // 1) 直接就是 id
  if (BARE_ID.test(raw)) return { awemeId: raw, resolvedFrom: 'raw-id' };

  // 2) URL 里本来就带 id
  const direct = extractIdFromString(raw);
  if (direct) return { awemeId: direct, resolvedFrom: 'url-path' };

  // 3) 短链 —— 跟一次跳转
  const url = extractUrl(raw);
  if (!url) throw new Error('没找到抖音链接，也没识别出作品 id');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      headers: { 'User-Agent': UA_MOBILE },
      signal: ctl.signal,
    });
    const fromFinal = extractIdFromString(res.url);
    if (fromFinal) return { awemeId: fromFinal, resolvedFrom: 'redirect' };

    // 有些短链跳转后 id 只在 HTML 里
    const body = await res.text();
    const fromBody = extractIdFromString(body);
    if (fromBody) return { awemeId: fromBody, resolvedFrom: 'redirect-body' };

    throw new Error('链接能打开但里面没有作品 id —— 作品可能已删除、设为私密，或链接已失效');
  } finally {
    clearTimeout(timer);
  }
}
