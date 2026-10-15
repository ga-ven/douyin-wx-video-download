/**
 * 对外 API。CLI 只是这一层的一层薄壳。
 *
 *   import { inspect, download } from 'douyin-video-download';
 *
 *   const meta = await inspect('https://v.douyin.com/xxxx/');
 *   const res  = await download('https://v.douyin.com/xxxx/', { quality: '720' });
 */

import path from 'node:path';
import fs from 'node:fs';
import { resolveAwemeId } from './resolve.js';
import { fetchAweme, isImagePost, describeAweme } from './feed.js';
import { enumerateStreams, enumerateImages, pickStream, watermarkedStream } from './streams.js';
import { downloadFile, verifyAgainstHash, md5File, DEFAULT_UA } from './download.js';
import { fetchViaBrowser } from './browser.js';
import { buildFilename, formatBytes, toNativePath, EXIT, sleep } from './util.js';

export { resolveAwemeId } from './resolve.js';
export { enumerateStreams, enumerateImages, pickStream } from './streams.js';
export { APP_UA, FEED_HOSTS, fetchAweme } from './feed.js';
export { downloadFile, md5File } from './download.js';
export { fetchViaBrowser, findChrome } from './browser.js';

function fail(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * 只取元信息，不下载。
 */
export async function inspect(input, {
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
      aweme_id: awemeId,
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
    if (!allowBrowser) {
      throw fail(e.message, EXIT.FETCH_FAILED);
    }
    logger?.warn('App Feed 接口不可用，改用无头浏览器兜底（会慢很多）');
    const b = await fetchViaBrowser(awemeId, { logger, ...browserOptions });
    return {
      aweme_id: awemeId,
      resolved_from: resolvedFrom,
      source: 'browser',
      source_host: 'www.douyin.com',
      meta: {
        aweme_id: awemeId,
        title: b.title || '',
        author: '',
        duration_sec: null,
        is_image_post: false,
        image_count: 0,
        page_url: `https://www.douyin.com/video/${awemeId}`,
      },
      streams: [{
        url: b.url,
        width: 0,
        height: 0,
        size: 0,
        codec: 'h264',
        label: '网页版 currentSrc',
        gear: null,
        file_hash: null,
      }],
      images: [],
      watermarked: null,
      _item: null,
    };
  }
}

/**
 * 下载。
 *
 * @param {string} input  分享链接 / 短链 / 纯 id / 分享文案
 * @param {object} opts
 *   out          显式输出文件路径（优先级最高）
 *   outDir       输出目录，默认当前目录
 *   template     文件名模板，默认 '{author}_{title}_{id}'
 *   quality      auto | best | h264 | hevc | 720 | 540p | 720_1_1
 *   watermarked  要带水印的方图版（默认 false）
 *   resume       续传，默认 true
 *   verify       用 file_hash 校验 MD5，默认 true
 *   allowBrowser 主路失败时启用无头浏览器兜底，默认 true
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
    resume = true,
    verify = true,
    allowBrowser = true,
    force = false,
    host = null,
    timeoutMs = 10000,
    onProgress = null,
    browserOptions = {},
    logger = null,
    inspector = inspect,
  } = opts;

  const info = await inspector(input, { host, timeoutMs, allowBrowser, logger, browserOptions });
  const base = buildFilename({
    author: info.meta.author,
    title: info.meta.title,
    awemeId: info.aweme_id,
    date: info.meta.created_at ? info.meta.created_at.slice(0, 10) : '',
  }, { template, ext: 'mp4' });

  const target = out ? path.resolve(toNativePath(out)) : path.join(path.resolve(toNativePath(outDir)), base);
  const result = {
    aweme_id: info.aweme_id,
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
      ? toNativePath(out).replace(/\.mp4$/i, '')
      : path.join(path.resolve(toNativePath(outDir)), base.replace(/\.mp4$/i, ''));
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
    chosen = pickStream(streams, quality);
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
    // 这么做是为了在"同名但档位不同"时能明确告诉用户手里那份到底是什么。
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
      const msg = `目标文件已存在，但档位不同：`
        + `现有 ${formatBytes(st.size)}（${matched.label}），所选 ${chosen.stream.label} ${formatBytes(chosen.stream.size)}`
        + ` —— 要换成所选档位请加 --force`;
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

  logger?.step(`下载 ${chosen.stream.width}x${chosen.stream.height} / ${chosen.stream.codec} -> ${path.basename(target)}`);
  const dl = await downloadFile(chosen.stream.url, target, {
    headers: { 'User-Agent': DEFAULT_UA, Referer: 'https://www.douyin.com/' },
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
  }

  result.files.push({ path: dl.path, bytes: dl.bytes, md5: dl.md5, verified, attempts: dl.attempts });
  return result;
}

export { EXIT };
export { toNativePath } from './util.js';
export const version = '1.0.0';
export { sleep };
