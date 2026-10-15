/**
 * 对外 API。CLI 只是这一层的一层薄壳。
 *
 *   import { inspect, download } from 'douyin-wx-video-download';
 *
 *   const meta = await inspect('https://v.douyin.com/xxxx/');          // 抖音，无需配置
 *   const res  = await download('https://weixin.qq.com/sph/xxxx', {   // 视频号，需要元宝 Cookie
 *     cookie: process.env.YUANBAO_COOKIE,
 *   });
 *
 * 两个平台：
 *   douyin   抖音 —— 走 App Feed 接口，只要正确的客户端 UA，不要 cookie / 签名
 *   channels 微信视频号 —— 走「元宝解析 + 视频号 feed_info」，**需要一个元宝登录 Cookie**
 */

import path from 'node:path';
import fs from 'node:fs';
import { resolveAwemeId } from './douyin/resolve.js';
import { fetchAweme, describeAweme } from './douyin/feed.js';
import { enumerateStreams, enumerateImages, pickStream, watermarkedStream } from './douyin/streams.js';
import { extractSphId } from './channels/resolve.js';
import { fetchChannelsFeed } from './channels/feed.js';
import {
  enumerateChannelsStreams,
  enumerateChannelsImages,
  channelsBgmUrl,
  pickChannelsStream,
  describeChannelsFeed,
} from './channels/streams.js';
import { downloadFile, verifyAgainstHash, md5File, DEFAULT_UA } from './download.js';
import { fetchViaBrowser } from './browser.js';
import { loadCookie } from './config.js';
import { buildFilename, formatBytes, toNativePath, EXIT, sleep } from './util.js';

export { resolveAwemeId } from './douyin/resolve.js';
export { enumerateStreams, enumerateImages, pickStream } from './douyin/streams.js';
export { APP_UA, FEED_HOSTS, fetchAweme } from './douyin/feed.js';
export { extractSphId } from './channels/resolve.js';
export { parseShareUrl, fetchFeedInfo, fetchChannelsFeed, ChannelsError, ChannelsUnavailableError } from './channels/feed.js';
export { enumerateChannelsStreams, enumerateChannelsImages, pickChannelsStream } from './channels/streams.js';
export { downloadFile, md5File } from './download.js';
export { fetchViaBrowser, findChrome } from './browser.js';
export { loadCookie, CONFIG_PATH, ENV_COOKIE, maskCookie } from './config.js';

const DOUYIN_HOSTS = /(^|\.)(douyin\.com|iesdouyin\.com)$/;
const WEIXIN_HOSTS = /(^|\.)(weixin\.qq\.com|channels\.weixin\.qq\.com)$/;

function firstUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>）)】]+/i);
  return m ? m[0] : '';
}

/**
 * 判断这条输入是哪家的。
 *   纯数字 → 抖音作品 id
 *   裸的 base62 短串 → 视频号 sph id
 *   带域名 → 按域名
 * 认不出来时返回 null，由调用方按抖音兜底试。
 */
export function detectPlatform(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (/^\d{6,}$/.test(s)) return 'douyin';

  const raw = firstUrl(s) || s;
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const host = u.hostname.toLowerCase();
    if (DOUYIN_HOSTS.test(host)) return 'douyin';
    if (WEIXIN_HOSTS.test(host)) return 'channels';
  } catch { /* 不是 URL，往下看裸 id */ }

  if (extractSphId(s)) return 'channels';
  return null;
}

function fail(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* ------------------------------------------------------------------ *
 * 抖音
 * ------------------------------------------------------------------ */

async function inspectDouyin(input, {
  host = null,
  timeoutMs = 10000,
  allowBrowser = false,
  logger = null,
  browserOptions = {},
} = {}) {
  const { awemeId, resolvedFrom } = await resolveAwemeId(input);
  const hosts = host ? [host] : undefined;

  try {
    const { item, host: usedHost } = await fetchAweme(awemeId, {
      hosts,
      timeoutMs,
      onHostError: (h, err) => logger?.info(`${h.replace(/^https?:\/\//, '')} 不可用：${err}`),
    });
    return {
      id: awemeId,
      platform: 'douyin',
      resolved_from: resolvedFrom,
      source: 'app_feed',
      source_host: usedHost,
      meta: describeAweme(item, awemeId),
      streams: enumerateStreams(item),
      images: enumerateImages(item),
      watermarked: watermarkedStream(item),
      _item: item,
    };
  } catch (e) {
    if (!allowBrowser) throw fail(e.message, EXIT.FETCH_FAILED);

    logger?.warn('App Feed 接口不可用，改用无头浏览器兜底（会慢很多）');
    const b = await fetchViaBrowser(awemeId, { logger, ...browserOptions });
    return {
      id: awemeId,
      platform: 'douyin',
      resolved_from: resolvedFrom,
      source: 'browser',
      source_host: 'www.douyin.com',
      meta: {
        id: awemeId,
        platform: 'douyin',
        title: b.title || '',
        description: b.title || '',
        author: '',
        duration_sec: null,
        created_at: null,
        is_image_post: false,
        image_count: 0,
        cover_url: '',
        page_url: `https://www.douyin.com/video/${awemeId}`,
      },
      streams: [{
        url: b.url,
        raw_url: b.url,
        width: null,
        height: null,
        quality_height: null,
        size: null,
        codec: 'h264',
        label: '网页版 currentSrc',
        gear: null,
        file_hash: null,
        vmaf: null,
        definition: null,
      }],
      images: [],
      watermarked: null,
      _item: null,
    };
  }
}

/* ------------------------------------------------------------------ *
 * 微信视频号
 * ------------------------------------------------------------------ */

async function inspectChannels(input, {
  cookie = null,
  cookieFile = null,
  resolved = null,
  timeoutMs = 15000,
  logger = null,
  fetchImpl = undefined,
} = {}) {
  const { cookie: ck, from } = loadCookie({ cookie, cookieFile, required: true });
  logger?.info(`使用元宝 Cookie（来源：${from}）`);

  const r = await fetchChannelsFeed(input, { cookie: ck, timeoutMs, logger, fetchImpl, resolved });
  const feedInfo = r.feed?.data?.feedInfo || {};

  return {
    id: r.sphId,
    platform: 'channels',
    resolved_from: r.resolvedFrom,
    source: 'yuanbao',
    source_host: 'channels.weixin.qq.com',
    meta: describeChannelsFeed(r.feed, r.sphId, r.url),
    streams: enumerateChannelsStreams(feedInfo),
    images: enumerateChannelsImages(feedInfo),
    watermarked: null,
    bgm_url: channelsBgmUrl(feedInfo),
    _feed: r.feed,
  };
}

/* ------------------------------------------------------------------ *
 * 统一入口
 * ------------------------------------------------------------------ */

/**
 * 只取元信息，不下载。
 *
 * @param {string} input 分享链接 / 短链 / 裸 id / 分享文案
 * @param {object} opts
 *   platform     'douyin' | 'channels'，不传则自动识别
 *   cookie       视频号用的元宝 Cookie
 *   host         抖音：只用一个接入点
 *   timeoutMs    单次请求超时
 *   allowBrowser 抖音：主路失败时启用无头浏览器兜底
 */
export async function inspect(input, {
  platform = null,
  cookie = null,
  cookieFile = null,
  host = null,
  timeoutMs,
  allowBrowser = false,
  logger = null,
  browserOptions = {},
  fetchImpl = undefined,
  resolved = null,
} = {}) {
  const p = platform || detectPlatform(input) || 'douyin';
  if (p === 'channels') {
    return inspectChannels(input, {
      cookie, cookieFile, resolved, logger, fetchImpl,
      timeoutMs: timeoutMs ?? 15000,
    });
  }
  return inspectDouyin(input, {
    host, allowBrowser, logger, browserOptions,
    timeoutMs: timeoutMs ?? 10000,
  });
}

/**
 * 下载。
 *
 * @param {string} input  分享链接 / 短链 / 纯 id / 分享文案
 * @param {object} opts
 *   out          显式输出文件路径（优先级最高）
 *   outDir       输出目录，默认当前目录
 *   template     文件名模板，默认 '{author}_{title}_{id}'
 *   quality      auto | best | h264 | hevc | 720 | 540 | 720_1_1
 *   cookie       视频号：元宝 Cookie
 *   resume       续传，默认 true
 *   verify       用 file_hash 校验 MD5，默认 true（视频号没有 file_hash，会自动跳过）
 *   allowBrowser 抖音主路失败时启用无头浏览器兜底，默认 true
 *   force        目标文件已存在时覆盖，默认 false
 *   inspector    高级：注入自定义取数函数，签名同 inspect()。主要给测试用
 */
export async function download(input, opts = {}) {
  const {
    out = null,
    outDir = process.cwd(),
    template = '{author}_{title}_{id}',
    quality = 'auto',
    watermarked = false,
    platform = null,
    cookie = null,
    cookieFile = null,
    resume = true,
    verify = true,
    allowBrowser = true,
    force = false,
    host = null,
    timeoutMs,
    onProgress = null,
    browserOptions = {},
    logger = null,
    inspector = inspect,
  } = opts;

  const info = await inspector(input, {
    platform, cookie, cookieFile, host, timeoutMs, allowBrowser, logger, browserOptions,
  });

  const base = buildFilename({
    author: info.meta.author,
    title: info.meta.title,
    id: info.id,
    date: info.meta.created_at ? info.meta.created_at.slice(0, 10) : '',
  }, { template, ext: 'mp4' });

  const target = out ? path.resolve(toNativePath(out)) : path.join(path.resolve(toNativePath(outDir)), base);
  const result = {
    id: info.id,
    platform: info.platform,
    source: info.source,
    source_host: info.source_host,
    meta: info.meta,
    type: info.meta.is_image_post ? 'images' : 'video',
    files: [],
    warnings: [],
  };

  // ---------- 图集 ----------
  if (info.meta.is_image_post) {
    const images = info.images;
    if (!images.length) throw fail('识别为图集但没有解析出任何图片', EXIT.FETCH_FAILED);
    const dir = out
      ? toNativePath(out).replace(/\.(mp4|jpg|jpeg|png)$/i, '')
      : path.join(path.resolve(toNativePath(outDir)), base.replace(/\.(mp4|jpg|jpeg|png)$/i, ''));
    await fs.promises.mkdir(dir, { recursive: true });
    logger?.step(`图集作品，共 ${images.length} 张原图 -> ${dir}`);
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const dest = path.join(dir, `${String(i + 1).padStart(2, '0')}.${img.ext}`);
      if (!force && fs.existsSync(dest)) {
        logger?.info(`跳过已存在: ${path.basename(dest)}`);
        result.files.push({ path: dest, bytes: (await fs.promises.stat(dest)).size, md5: null, verified: null, skipped: true });
        continue;
      }
      const r = await downloadFile(img.url, dest, {
        headers: { 'User-Agent': DEFAULT_UA, Referer: 'https://www.douyin.com/' },
        resume,
        logger,
      });
      logger?.info(`[${i + 1}/${images.length}] ${path.basename(dest)}  ${r.bytes} B`);
      result.files.push({ path: r.path, bytes: r.bytes, md5: r.md5, verified: null });
    }
    return result;
  }

  // ---------- 视频 ----------
  const streams = info.streams;
  if (!streams.length) throw fail('没有解析到任何可用档位', EXIT.FETCH_FAILED);

  let chosen;
  if (watermarked) {
    if (!info.watermarked) throw fail('这条作品没有带水印的版本', EXIT.FETCH_FAILED);
    chosen = { stream: info.watermarked, reason: '显式要求带水印版' };
    result.warnings.push('选择了带水印版本（download_addr 方图）');
  } else {
    chosen = info.platform === 'channels'
      ? pickChannelsStream(streams, quality)
      : pickStream(streams, quality);
  }
  if (!chosen.stream) throw fail('没有匹配到可用档位', EXIT.FETCH_FAILED);

  result.chosen = {
    label: chosen.stream.label,
    reason: chosen.reason,
    codec: chosen.stream.codec,
    width: chosen.stream.width,
    height: chosen.stream.height,
    size: chosen.stream.size,
    file_hash: chosen.stream.file_hash,
  };
  result.streams = streams.map((s) => ({
    label: s.label, gear: s.gear, codec: s.codec,
    width: s.width, height: s.height, size: s.size, vmaf: s.vmaf,
  }));

  if (!force && fs.existsSync(target)) {
    const st = await fs.promises.stat(target);
    const existingMd5 = await md5File(target);

    // 已有文件是哪一档？优先按 file_hash 认，认不出就按体积认。
    // （视频号没有 file_hash，这里会退化成按体积——多数情况下也比没有强。）
    let matched = streams.find((s) => s.file_hash
      && s.file_hash.toLowerCase() === existingMd5.toLowerCase()) || null;
    if (!matched) {
      const bySize = streams.filter((s) => s.size && s.size === st.size);
      if (bySize.includes(chosen.stream)) matched = chosen.stream;
      else if (bySize.length === 1) matched = bySize[0];
    }

    let sameAsChosen = null;
    if (matched) sameAsChosen = matched === chosen.stream;

    if (sameAsChosen === false) {
      const msg = '目标文件已存在，但档位不同：'
        + `现有 ${formatBytes(st.size)}（${matched.label}），所选 ${chosen.stream.label} ${formatBytes(chosen.stream.size)}`
        + ' —— 要换成所选档位请加 --force';
      logger?.warn(msg);
      result.warnings.push(msg);
    } else {
      logger?.warn(`目标文件已存在，跳过下载：${path.basename(target)}（要覆盖请加 --force）`);
    }

    // 跳过 ≠ 校验失败：verified 保持 null，另用 same_as_chosen 表达"是不是你要的那档"
    result.files.push({
      path: target, bytes: st.size, md5: existingMd5,
      verified: null, skipped: true, same_as_chosen: sameAsChosen,
      existing_stream: matched ? matched.label : null,
    });
    return result;
  }

  const referer = info.platform === 'channels'
    ? 'https://channels.weixin.qq.com/'
    : 'https://www.douyin.com/';

  logger?.step(`下载 ${chosen.stream.label}（${chosen.stream.codec}）-> ${path.basename(target)}`);
  const dl = await downloadFile(chosen.stream.url, target, {
    headers: { 'User-Agent': DEFAULT_UA, Referer: referer },
    resume,
    onProgress,
    logger,
  });

  let verified = null;
  if (verify && chosen.stream.file_hash) {
    const v = verifyAgainstHash(dl.md5, chosen.stream.file_hash);
    verified = v.ok;
    if (!v.ok) {
      result.warnings.push(`MD5 与接口 file_hash 不一致（期望 ${v.expected}，实际 ${v.actual}）`);
      logger?.warn(result.warnings[result.warnings.length - 1]);
    }
  } else if (verify && info.platform === 'channels') {
    result.warnings.push('视频号接口不提供 file_hash，已跳过 MD5 校验（用体积与可播放性自查）');
  }

  result.files.push({ path: dl.path, bytes: dl.bytes, md5: dl.md5, verified, attempts: dl.attempts });
  return result;
}

export { EXIT };
export { toNativePath } from './util.js';
export const version = '2.0.0';
export { sleep };
